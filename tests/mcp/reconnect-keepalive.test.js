/**
 * Regression tests for the 2026-06-11 slack-ask disconnect incident.
 *
 * Three bugs conspired to kill an in-flight ask_user call:
 *   1. The server cached one StreamableHTTPServerTransport per sessionId
 *      forever; a client reconnect (fresh `initialize`) was rejected with
 *      "400 Server already initialized" — every reconnect, permanently.
 *   2. The standalone SSE GET stream carried zero traffic, so Claude Code
 *      aborted it every 300s and counted each abort as a connection error
 *      (3 strikes → transport closed mid-call).
 *   3. A blocked ask_user call sent no progress notifications, so the
 *      client's 60s per-request timeout would kill any question the user
 *      didn't answer within a minute.
 *
 * Covered here:
 *   - re-initialize over real HTTP replaces the stale transport (bug 1)
 *   - ask_user ticks progress notifications while pending (bug 3)
 *   - ask_user updates sessions.last_bot_ts so the inflight watchdog
 *     doesn't post "agent may be stuck" while a question is pending
 *     (companion fix for the socket.js watchdog anchor)
 *
 * Bug 2's fix (the 60s server→client ping) is exercised implicitly: the
 * HTTP test runs with MCP_KEEPALIVE_MS=50 so pings fire during the test
 * and must not crash the transport.
 */

const Database = require('better-sqlite3');

const skipSuite = (() => {
    try {
        require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return false;
    } catch {
        return true;
    }
})();

const maybeDescribe = skipSuite ? describe.skip : describe;

maybeDescribe('MCP reconnect + keepalive', () => {
    let Client;
    let StreamableHTTPClientTransport;
    let InMemoryTransport;
    let startMcpServer;
    let stopMcpServer;
    let createMcpServer;
    let resolvePending;
    let listPending;
    let cancelPending;
    let db;
    let slackApp;
    const savedEnv = {};

    beforeAll(() => {
        ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
        ({ StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js'));
        ({ InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js'));
        ({ startMcpServer, stopMcpServer, createMcpServer } = require('../../src/mcp/server'));
        ({ resolvePending, listPending, cancelPending } = require('../../src/mcp/ask-user-tool'));

        for (const k of ['MCP_KEEPALIVE_MS', 'MCP_PROGRESS_INTERVAL_MS']) {
            savedEnv[k] = process.env[k];
        }
        process.env.MCP_KEEPALIVE_MS = '50';
        process.env.MCP_PROGRESS_INTERVAL_MS = '50';
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    beforeEach(() => {
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
    });

    afterEach(async () => {
        for (const p of listPending()) cancelPending(p.requestId, 'cancelled');
        await stopMcpServer();
        db.close();
    });

    test('re-initialize for a cached sessionId replaces the stale transport instead of 400', async () => {
        const { url } = await startMcpServer({ db, slackApp, force: true, port: 0 });

        // First client connects and works.
        const c1 = new Client({ name: 'first', version: '0.0.1' }, { capabilities: {} });
        await c1.connect(new StreamableHTTPClientTransport(new URL(`${url}/test-session`)));
        const first = await c1.listTools();
        expect(first.tools.map((t) => t.name)).toContain('ask_user');

        // Simulate a dropped client: c1 is abandoned WITHOUT a DELETE, so
        // the server still holds its transport. A second client now sends
        // a fresh `initialize` on the same session path — pre-fix this got
        // "400 Server already initialized" forever.
        const c2 = new Client({ name: 'second', version: '0.0.1' }, { capabilities: {} });
        await c2.connect(new StreamableHTTPClientTransport(new URL(`${url}/test-session`)));
        const second = await c2.listTools();
        expect(second.tools.map((t) => t.name)).toContain('ask_user');

        try { await c1.close(); } catch { /* stale by design */ }
        await c2.close();
    });

    test('ask_user sends progress notifications while waiting and updates last_bot_ts', async () => {
        const mcpServer = createMcpServer({ db, slackApp, sessionId: 'test-session' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'loopback', version: '0.0.1' }, { capabilities: {} });
        await client.connect(clientTransport);

        const progressEvents = [];
        const callPromise = client.callTool(
            {
                name: 'ask_user',
                arguments: { questions: [{ id: 'q', type: 'text', question: 'Deploy?' }] },
            },
            undefined,
            { onprogress: (p) => progressEvents.push(p) },
        );

        const requestId = await waitForPending();

        // The question post must count as bot activity for the inflight
        // watchdog (anchored to last_bot_ts), otherwise a pending question
        // triggers the "No response after 15min" give-up notice.
        const row = db.prepare('SELECT last_bot_ts FROM sessions WHERE session_key = ?').get('test-session');
        expect(row.last_bot_ts).toBe('1700000001.000200');

        // With MCP_PROGRESS_INTERVAL_MS=50, a few ticks land while pending.
        await new Promise((r) => setTimeout(r, 250));
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents[0].message).toMatch(/Slack/);

        resolvePending(requestId, { answers: { q: 'yes' }, status: 'ok' });
        const result = await callPromise;
        expect(JSON.parse(result.content[0].text)).toEqual({ answers: { q: 'yes' }, status: 'ok' });

        await client.close();
        await mcpServer.close();
    });

    // ─── Helpers ──────────────────────────────────────────────────────

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
