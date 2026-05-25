/**
 * Tier C — full MCP loopback test.
 *
 * Exercises the end-to-end happy path without HTTP, without Slack, and
 * without a real CLI:
 *
 *   Client.callTool('ask_user', …)
 *     → Server's handleAskUser
 *     → mocked Slack chat.postMessage  ← asserted
 *     → pending promise stored
 *     → test code calls resolvePending(requestId, answer)
 *     → tool returns; client receives result  ← asserted
 *
 * Uses `@modelcontextprotocol/sdk` InMemoryTransport so the test is
 * deterministic and runs in <100ms. The HTTP transport is exercised
 * indirectly via syntax check; full HTTP exercise lands in Phase 2.
 *
 * If the SDK isn't installed (e.g. `npm install` hasn't run), the whole
 * suite is skipped with a clear marker — `node --check` still passes.
 */

const Database = require('better-sqlite3');

const skipSuite = (() => {
    try {
        require.resolve('@modelcontextprotocol/sdk/inMemory.js');
        return false;
    } catch {
        return true;
    }
})();

const maybeDescribe = skipSuite ? describe.skip : describe;

maybeDescribe('MCP loopback — ask_user end-to-end', () => {
    let Client;
    let InMemoryTransport;
    let createMcpServer;
    let resolvePending;
    let listPending;
    let cancelPending;
    let db;
    let slackApp;
    let mcpServer;
    let serverTransport;
    let client;

    beforeAll(async () => {
        ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
        ({ InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js'));
        ({ createMcpServer } = require('../../src/mcp/server'));
        ({ resolvePending, listPending, cancelPending } =
            require('../../src/mcp/ask-user-tool'));
    });

    beforeEach(async () => {
        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE sessions (
                session_key  TEXT PRIMARY KEY,
                session_name TEXT NOT NULL,
                channel_id   TEXT NOT NULL,
                thread_ts    TEXT NOT NULL,
                repo_path    TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                last_bot_ts  TEXT
            )
        `);
        db.prepare(`
            INSERT INTO sessions
            (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at)
            VALUES ('test-session', 'test', 'C12345', '1700000000.000100', '/tmp', 0, 0)
        `).run();

        slackApp = {
            client: {
                chat: {
                    postMessage: jest.fn(async () => ({ ok: true, ts: '1700000001.000200' })),
                    update: jest.fn(async () => ({ ok: true })),
                },
                views: {
                    open: jest.fn(async () => ({ ok: true })),
                    update: jest.fn(async () => ({ ok: true })),
                },
            },
        };

        mcpServer = createMcpServer({ db, slackApp, sessionId: 'test-session' });

        const [clientTransport, _serverTransport] = InMemoryTransport.createLinkedPair();
        serverTransport = _serverTransport;
        await mcpServer.connect(serverTransport);

        client = new Client({ name: 'loopback-test', version: '0.0.1' }, { capabilities: {} });
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        // Clear anything still pending so timeouts don't leak between tests.
        for (const p of listPending()) cancelPending(p.requestId, 'cancelled');
        try { await client.close(); } catch {}
        try { await mcpServer.close(); } catch {}
        db.close();
    });

    test('tools/list advertises ask_user', async () => {
        const result = await client.listTools();
        expect(result.tools.map((t) => t.name)).toContain('ask_user');
        const def = result.tools.find((t) => t.name === 'ask_user');
        expect(def.description).toMatch(/Slack/i);
    });

    test('single-select call posts to Slack and returns the resolved answer', async () => {
        const callPromise = client.callTool({
            name: 'ask_user',
            arguments: {
                type: 'select',
                question: 'Scope of work?',
                options: [
                    { label: 'Plans only', value: 'plans' },
                    { label: 'Plans + skeleton', value: 'skel' },
                    { label: 'Plans + full PR', value: 'full' },
                ],
            },
        });

        // Wait until the handler has registered a pending entry, then
        // resolve as if Slack delivered a button-tap event.
        const requestId = await waitForPending();
        resolvePending(requestId, { answers: { _: 'skel' }, status: 'ok' });

        const result = await callPromise;
        expect(slackApp.client.chat.postMessage).toHaveBeenCalledTimes(1);

        const slackArgs = slackApp.client.chat.postMessage.mock.calls[0][0];
        expect(slackArgs.channel).toBe('C12345');
        expect(slackArgs.thread_ts).toBe('1700000000.000100');

        const answer = JSON.parse(result.content[0].text);
        expect(answer).toEqual({ answer: 'skel', status: 'ok' });
    });

    test('multi-question call returns answers keyed by question id', async () => {
        const callPromise = client.callTool({
            name: 'ask_user',
            arguments: {
                questions: [
                    { id: 'pkg', type: 'select', question: 'Pkg?', options: [{ label: 'a' }, { label: 'b' }] },
                    { id: 'note', type: 'text', question: 'Note?' },
                ],
                title: 'Mixed',
            },
        });

        const requestId = await waitForPending();
        resolvePending(requestId, {
            answers: { pkg: 'a', note: 'hello' },
            status: 'ok',
        });

        const result = await callPromise;
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('ok');
        expect(parsed.answers).toEqual({ pkg: 'a', note: 'hello' });
    });

    test('timeout resolves with status=timeout (no leak)', async () => {
        const callPromise = client.callTool({
            name: 'ask_user',
            arguments: {
                type: 'text',
                question: 'You there?',
                timeout_ms: 100,
            },
        });

        await waitForPending();

        const result = await callPromise;
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('timeout');
        expect(listPending()).toHaveLength(0);
    });

    test('handler errors when no Slack session exists for the sessionId', async () => {
        // Replace the session row with a different key so the lookup misses.
        db.prepare('DELETE FROM sessions').run();

        await expect(
            client.callTool({
                name: 'ask_user',
                arguments: { type: 'text', question: 'Q?' },
            }),
        ).rejects.toThrow(/no Slack session/i);
    });

    // ─── Helpers ──────────────────────────────────────────────────────

    /** Poll until the tool handler has stashed a pending entry, return its requestId. */
    async function waitForPending(timeoutMs = 1000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const pending = listPending();
            if (pending.length > 0) return pending[pending.length - 1].requestId;
            await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('timed out waiting for pending question');
    }
});
