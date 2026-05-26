/**
 * MCP HTTP server bootstrap for the `slack-ask` server.
 *
 * Lifts an MCP SDK transport per tmux session. The session id is taken from
 * the URL path (`/mcp/:sessionId`) and threaded into the tool handler via
 * `connectionContext`, so a single tool implementation serves every session.
 *
 * NOTE — Phase 1 scaffold:
 *   - Express route registration lives here but the bot does NOT call
 *     `startMcpServer()` yet; Phase 2 wires it into start-slack-socket.js.
 *   - The MCP SDK import is loaded lazily so non-MCP installs keep working
 *     even before `npm install` runs against the new dependency.
 */

const express = require('express');
const Logger = require('../core/logger');

const { askUserToolDefinition } = require('./ask-user-tool');

// Lazy require so the rest of the bot keeps working before the SDK lands in
// node_modules. If we import at module top and the package is missing,
// `require('./mcp')` from start-slack-socket.js explodes.
function loadMcpSdk() {
    try {
        // eslint-disable-next-line global-require
        const sdkServer = require('@modelcontextprotocol/sdk/server/index.js');
        // eslint-disable-next-line global-require
        const sdkTransport = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
        // eslint-disable-next-line global-require
        const sdkTypes = require('@modelcontextprotocol/sdk/types.js');
        return {
            Server: sdkServer.Server,
            StreamableHTTPServerTransport: sdkTransport.StreamableHTTPServerTransport,
            ListToolsRequestSchema: sdkTypes.ListToolsRequestSchema,
            CallToolRequestSchema: sdkTypes.CallToolRequestSchema,
        };
    } catch (err) {
        throw new Error(
            '@modelcontextprotocol/sdk is not installed. Run `npm install` after pulling ' +
            'this branch, or set MCP_ENABLED=false to disable the slack-ask server.\n' +
            `Original error: ${err.message}`,
        );
    }
}

// Module-level state — we hold one Express sub-router and one HTTP server
// handle so stopMcpServer() can shut it down cleanly on bot restart.
let logger = null;
let httpServer = null;
let serverUrl = null;
const transports = new Map(); // sessionId → { transport, mcpServer }

/**
 * Start the MCP HTTP server.
 *
 * @param {object} opts
 * @param {object} opts.config           — bot config bundle (db, slackApp, …)
 * @param {object} opts.db               — better-sqlite3 handle for session lookups
 * @param {object} opts.slackApp         — @slack/bolt App for posting
 * @param {number} [opts.port]           — bind port; defaults to MCP_PORT env. Pass 0 for ephemeral.
 * @param {string} [opts.host]           — bind host; defaults to MCP_BIND_HOST env
 * @param {boolean} [opts.force]         — start even if MCP_ENABLED!=true (tests only)
 * @param {function} [opts.getDb]        — preferred over `db`: returns the
 *     current better-sqlite3 handle on each call. Required for prod because
 *     the bot's daily-restart replaces `handler.db` mid-process; a captured
 *     handle goes stale and tool calls error with "database connection is
 *     not open". Tests can keep passing a static `db`.
 * @returns {Promise<{ url: string, port: number }>}
 */
async function startMcpServer({ config, db, slackApp, getDb, port, host, force } = {}) {
    if (!force && process.env.MCP_ENABLED !== 'true') {
        return { url: null, disabled: true };
    }

    logger = logger || new Logger('McpServer');

    const sdk = loadMcpSdk();
    const { Server, StreamableHTTPServerTransport } = sdk;

    const bindPort = Number(port || process.env.MCP_PORT || 9998);
    const bindHost = host || process.env.MCP_BIND_HOST || '127.0.0.1';

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    // Per-session transport. The MCP SDK expects one transport per logical
    // connection; we key by tmux session id so multiple agents can talk to
    // the same in-process tool registry concurrently.
    app.all('/mcp/:sessionId', async (req, res) => {
        const { sessionId } = req.params;
        if (!sessionId) {
            res.status(400).json({ error: 'sessionId required in path' });
            return;
        }

        let entry = transports.get(sessionId);
        if (!entry) {
            const mcpServer = createMcpServer({ db, getDb, slackApp, sessionId, config }, sdk);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
            });
            await mcpServer.connect(transport);

            entry = { transport, mcpServer };
            transports.set(sessionId, entry);
            logger.info(`mcp: opened transport for session ${sessionId}`);
        }

        try {
            await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
            logger.error(`mcp: transport handleRequest failed: ${err.message}`);
            if (!res.headersSent) res.status(500).end();
        }
    });

    await new Promise((resolve, reject) => {
        httpServer = app.listen(bindPort, bindHost, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // After listen, address() carries the actual port (matters for port: 0).
    const actualPort = httpServer.address().port;
    const url = `http://${bindHost}:${actualPort}/mcp`;
    serverUrl = url;
    logger.info(`mcp: slack-ask server listening at ${url}/<sessionId>`);
    return { url, port: actualPort };
}

/**
 * Return the base URL of the running MCP server (e.g. http://127.0.0.1:9998/mcp),
 * or null if the server hasn't been started. Callers append `/<sessionId>` for
 * per-session routing.
 */
function getServerUrl() {
    return serverUrl;
}

/**
 * Build an MCP `Server` instance with the `ask_user` tool registered.
 *
 * Exported so tests can wire it to an `InMemoryTransport` and exercise the
 * full handler path without HTTP. Production callers normally go through
 * `startMcpServer()`, which spins one of these per tmux session.
 *
 * @param {object} ctx       — { db, slackApp, sessionId, config }
 * @param {object} [sdk]     — pre-loaded SDK bundle; loaded lazily if omitted
 * @returns {object} an MCP Server (call `.connect(transport)` to attach)
 */
function createMcpServer(ctx, sdk) {
    const resolvedSdk = sdk || loadMcpSdk();
    const { Server } = resolvedSdk;
    const mcpServer = new Server(
        { name: 'slack-ask', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );
    registerAskUserTool(mcpServer, ctx, resolvedSdk);
    return mcpServer;
}

/**
 * Register the `ask_user` tool on an MCP server instance. Split out so
 * future tools can be added the same way.
 */
function registerAskUserTool(mcpServer, ctx, sdk) {
    // The MCP SDK's request handler shape — the actual handler delegates
    // to ask-user-tool.handleAskUser, which owns the pending-question
    // promise registry and the Slack post.
    const { handleAskUser } = require('./ask-user-tool');
    const { ListToolsRequestSchema, CallToolRequestSchema } = sdk;

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [askUserToolDefinition],
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
        if (req.params.name !== 'ask_user') {
            throw new Error(`Unknown tool: ${req.params.name}`);
        }
        return handleAskUser(req.params.arguments || {}, ctx);
    });
}

async function stopMcpServer() {
    if (!httpServer) return;
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
    serverUrl = null;
    for (const [, entry] of transports) {
        try {
            await entry.mcpServer.close?.();
        } catch (err) {
            (logger || console).warn(`mcp: failed to close server: ${err.message}`);
        }
    }
    transports.clear();
    if (logger) logger.info('mcp: slack-ask server stopped');
}

module.exports = {
    startMcpServer,
    stopMcpServer,
    createMcpServer,
    getServerUrl,
};
