#!/usr/bin/env node
/**
 * Bridge MCP stdio clients to the bot's HTTP slack-ask MCP server.
 *
 * STATUS — currently UNUSED. All three CLIs (Claude / Codex / Gemini) now
 * connect to the in-process MCP server over native streamable HTTP:
 *   - Claude: `--mcp-config <file>` per session (claude-adapter.js)
 *   - Codex:  `-c mcp_servers.slackask.url=...` per launch (codex-adapter.js)
 *   - Gemini: ~/.gemini/settings.json with `${CLAUDE_REMOTE_MCP_URL_FULL}`
 *             expansion (gemini-adapter.js)
 *
 * Kept here as a tested fallback in case any CLI ever drops HTTP transport
 * support (e.g. a future regression that forces stdio-only MCP). To use:
 * wire it in via the adapter's installMcp, set CLAUDE_REMOTE_SESSION_ID
 * and CLAUDE_REMOTE_MCP_URL in extraEnv, and the proxy bridges stdio↔HTTP.
 *
 * Stdout is reserved for JSON-RPC frames. Diagnostics must go to stderr.
 */

async function main() {
    const sessionId = process.env.CLAUDE_REMOTE_SESSION_ID;
    const mcpUrlBase = process.env.CLAUDE_REMOTE_MCP_URL;
    if (!sessionId || !mcpUrlBase) {
        writeStderr('mcp-stdio-proxy: missing CLAUDE_REMOTE_SESSION_ID or CLAUDE_REMOTE_MCP_URL\n');
        process.exit(1);
    }

    const {
        Client,
        StreamableHTTPClientTransport,
        Server,
        StdioServerTransport,
        ListToolsRequestSchema,
        CallToolRequestSchema,
    } = loadMcpSdk();

    const base = String(mcpUrlBase).replace(/\/+$/, '');
    const targetUrl = new URL(`${base}/${encodeURIComponent(sessionId)}`);

    const httpTransport = new StreamableHTTPClientTransport(targetUrl);
    const client = new Client(
        { name: 'mcp-stdio-proxy', version: '0.1.0' },
        { capabilities: {} },
    );
    await client.connect(httpTransport);

    const server = new Server(
        { name: 'slack-ask-proxy', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
    server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool(req.params));

    const stdio = new StdioServerTransport();
    await server.connect(stdio);

    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        try { await server.close(); } catch {}
        try { await client.close(); } catch {}
    };

    process.once('SIGTERM', async () => {
        await close();
        process.exit(0);
    });
    process.once('SIGINT', async () => {
        await close();
        process.exit(0);
    });
}

function loadMcpSdk() {
    return {
        // eslint-disable-next-line global-require
        Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
        // eslint-disable-next-line global-require
        StreamableHTTPClientTransport: require('@modelcontextprotocol/sdk/client/streamableHttp.js')
            .StreamableHTTPClientTransport,
        // eslint-disable-next-line global-require
        Server: require('@modelcontextprotocol/sdk/server/index.js').Server,
        // eslint-disable-next-line global-require
        StdioServerTransport: require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport,
        // eslint-disable-next-line global-require
        ListToolsRequestSchema: require('@modelcontextprotocol/sdk/types.js').ListToolsRequestSchema,
        // eslint-disable-next-line global-require
        CallToolRequestSchema: require('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema,
    };
}

function writeStderr(message) {
    try {
        require('fs').writeSync(2, message);
    } catch {
        process.stderr.write(message);
    }
}

main().catch((err) => {
    writeStderr(`mcp-stdio-proxy fatal: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
});
