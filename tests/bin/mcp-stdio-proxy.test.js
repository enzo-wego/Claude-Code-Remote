/**
 * mcp-stdio-proxy bridges a stdio MCP client to the bot's HTTP MCP server.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PROXY_PATH = path.resolve(__dirname, '../../bin/mcp-stdio-proxy.js');

const skipSuite = (() => {
    try {
        require.resolve('@modelcontextprotocol/sdk/client/index.js');
        require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
        return false;
    } catch {
        return true;
    }
})();

const maybeDescribe = skipSuite ? describe.skip : describe;

maybeDescribe('mcp-stdio-proxy', () => {
    let Client;
    let StdioClientTransport;
    let startMcpServer;
    let stopMcpServer;
    let db;

    beforeAll(() => {
        ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
        ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
        ({ startMcpServer, stopMcpServer } = require('../../src/mcp/server'));
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
    });

    afterEach(async () => {
        try { await stopMcpServer(); } catch {}
        try { db.close(); } catch {}
    });

    test('exits with a clear error when env vars are missing', async () => {
        const result = await runProxyWithoutEnv();
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('missing CLAUDE_REMOTE_SESSION_ID or CLAUDE_REMOTE_MCP_URL');
    });

    test('forwards tools/list from stdio to the HTTP MCP server', async () => {
        expect(fs.existsSync(PROXY_PATH)).toBe(true);

        const slackApp = {
            client: {
                chat: { postMessage: jest.fn(), update: jest.fn() },
                views: { open: jest.fn(), update: jest.fn() },
            },
        };
        const { url } = await startMcpServer({
            db,
            slackApp,
            port: 0,
            host: '127.0.0.1',
            force: true,
        });

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [PROXY_PATH],
            env: {
                CLAUDE_REMOTE_SESSION_ID: 'test-session',
                CLAUDE_REMOTE_MCP_URL: url,
            },
            stderr: 'pipe',
        });
        const client = new Client({ name: 'proxy-test', version: '0.0.1' }, { capabilities: {} });

        try {
            await client.connect(transport);
            const result = await client.listTools();
            expect(result.tools.map((tool) => tool.name)).toContain('ask_user');
        } finally {
            try { await client.close(); } catch {}
            try { await transport.close(); } catch {}
        }
    });
});

function runProxyWithoutEnv() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [PROXY_PATH], {
            env: { PATH: process.env.PATH },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('close', (code) => resolve({ code, stderr }));
    });
}
