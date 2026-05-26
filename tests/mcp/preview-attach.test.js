/**
 * Phase 3 C2 — file-attach fallback for long preview bodies.
 *
 * When a preview question's body would be truncated in the in-modal /
 * in-thread render (Slack mrkdwn section caps around 3000 chars), the
 * poster uploads the FULL body as a file in the same thread so the user
 * has the complete content. Verified by mocking slackApp.client.files
 * .uploadV2 and counting calls.
 *
 * Re-requires ask-user-tool through the loopback path so the same code
 * path the agent triggers gets exercised end-to-end.
 */

const Database = require('better-sqlite3');
const { handleAskUser } = require('../../src/mcp/ask-user-tool');

function buildCtx() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, repo_path TEXT NOT NULL DEFAULT '/tmp', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
    db.prepare('INSERT INTO sessions (session_key, channel_id, thread_ts) VALUES (?,?,?)')
        .run('test-session', 'C123', '111.222');

    const calls = { postMessage: [], uploadV2: [] };
    const slackApp = {
        client: {
            chat: {
                postMessage: jest.fn(async (args) => { calls.postMessage.push(args); return { ts: '999.001' }; }),
            },
            files: {
                uploadV2: jest.fn(async (args) => { calls.uploadV2.push(args); return { ok: true }; }),
            },
        },
    };
    return { db, slackApp, calls };
}

describe('preview file-attach fallback', () => {
    afterEach(() => {
        // Cancel any pending entries left over from a failed test — the
        // pending Map is module-scoped, so a leak from one test breaks the
        // next test's listPending assertions.
        const { listPending, cancelPending } = require('../../src/mcp/ask-user-tool');
        for (const e of listPending()) cancelPending(e.requestId, 'test-cleanup');
    });

    test('short preview body → no files.uploadV2', async () => {
        const { db, slackApp, calls } = buildCtx();
        const callPromise = handleAskUser(
            {
                questions: [{
                    id: 'diff',
                    type: 'preview',
                    question: 'Apply?',
                    language: 'diff',
                    body: '+ small\n- change',
                    buttons: [{ label: 'Approve', value: 'yes' }],
                }],
            },
            { sessionId: 'test-session', db, slackApp },
        );

        // Tool blocks; we don't await it. Wait briefly for postQuestion to run.
        await new Promise((r) => setTimeout(r, 50));

        expect(calls.postMessage).toHaveLength(1);
        expect(calls.uploadV2).toHaveLength(0); // short body — no attach
        // Resolve to clean up the pending promise.
        const { resolvePending, listPending } = require('../../src/mcp/ask-user-tool');
        const pending = listPending();
        if (pending.length > 0) resolvePending(pending[0].requestId, { answers: { diff: 'yes' }, status: 'ok' });
        await callPromise;
    });

    test('long preview body → files.uploadV2 called with full content', async () => {
        const { db, slackApp, calls } = buildCtx();
        const longBody = 'x'.repeat(3500);
        const callPromise = handleAskUser(
            {
                questions: [{
                    id: 'bigdiff',
                    type: 'preview',
                    question: 'Apply this large patch?',
                    language: 'diff',
                    body: longBody,
                }],
            },
            { sessionId: 'test-session', db, slackApp },
        );

        await new Promise((r) => setTimeout(r, 50));

        expect(calls.postMessage).toHaveLength(1);
        expect(calls.uploadV2).toHaveLength(1);
        const up = calls.uploadV2[0];
        expect(up.channel_id).toBe('C123');
        expect(up.thread_ts).toBe('111.222');
        expect(up.filename).toMatch(/^preview-bigdiff-\d+\.diff$/);
        expect(up.content).toBe(longBody);
        expect(up.initial_comment).toContain('Apply this large patch');

        const { resolvePending, listPending } = require('../../src/mcp/ask-user-tool');
        const pending = listPending();
        if (pending.length > 0) resolvePending(pending[0].requestId, { answers: { bigdiff: 'yes' }, status: 'ok' });
        await callPromise;
    });

    test('language with shell metachars → sanitized in filename', async () => {
        const { db, slackApp, calls } = buildCtx();
        const callPromise = handleAskUser(
            {
                questions: [{
                    id: 'q',
                    type: 'preview',
                    question: 'p',
                    language: '; rm -rf /',
                    body: 'x'.repeat(3500),
                }],
            },
            { sessionId: 'test-session', db, slackApp },
        );

        await new Promise((r) => setTimeout(r, 50));

        const up = calls.uploadV2[0];
        // Sanitizer strips /[^A-Za-z0-9._-]/g — spaces, semicolons, slashes
        // gone; dashes preserved. "; rm -rf /" → "rm-rf".
        expect(up.filename).toMatch(/^preview-q-\d+\.rm-rf$/);

        const { resolvePending, listPending } = require('../../src/mcp/ask-user-tool');
        const pending = listPending();
        if (pending.length > 0) resolvePending(pending[0].requestId, { answers: { q: 'yes' }, status: 'ok' });
        await callPromise;
    });

    test('preview uploadV2 failure logs warn but does NOT throw', async () => {
        const { db, slackApp } = buildCtx();
        slackApp.client.files.uploadV2 = jest.fn(async () => { throw new Error('boom'); });

        const callPromise = handleAskUser(
            {
                questions: [{
                    id: 'q',
                    type: 'preview',
                    question: 'p',
                    body: 'x'.repeat(3500),
                }],
            },
            { sessionId: 'test-session', db, slackApp },
        );

        // Should not have thrown despite the upload failing.
        await new Promise((r) => setTimeout(r, 50));

        const { resolvePending, listPending } = require('../../src/mcp/ask-user-tool');
        const pending = listPending();
        expect(pending).toHaveLength(1); // still pending — main flow unaffected
        resolvePending(pending[0].requestId, { answers: { q: 'yes' }, status: 'ok' });
        const result = await callPromise;
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('ok'); // tool completed normally
    });
});
