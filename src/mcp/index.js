/**
 * MCP `slack-ask` module — interactive-question back-channel.
 *
 * See docs/mcp-ask-user.md for the full design. Public surface kept small so
 * Phase 2 wiring (start-slack-socket.js, socket.js) imports only this barrel.
 *
 * Nothing here runs unless MCP_ENABLED=true at startup.
 */

const { startMcpServer, stopMcpServer, getServerUrl } = require('./server');
const { resolvePending, listPending, cancelPending } = require('./ask-user-tool');
const { wireSlackInteractions } = require('./poster');

module.exports = {
    startMcpServer,
    stopMcpServer,
    getServerUrl,
    wireSlackInteractions,
    resolvePending,
    listPending,
    cancelPending,
};
