'use strict';

/**
 * T01: Public surface for src/graph-ingest.
 *
 * Usage in socket.js:
 *   const graphIngest = require('../../graph-ingest');
 *   await graphIngest.start({ app, logger });
 *   graphIngest.handle(event, client).catch(...);
 *   await graphIngest.stop();
 *   await graphIngest.flush();
 */

const { NameCache } = require('./cache');
const { NdjsonBuffer } = require('./buffer');
const { post: forwarderPost } = require('./forwarder');
const { handle: _handle } = require('./handler');
const { loadConfig } = require('./config-loader');

// Module-level singletons (initialised by start())
let _cache = null;
let _buffer = null;
let _logger = null;
let _started = false;

/**
 * Initialise the graph-ingest subsystem.
 * Called once on startup when GRAPH_INGEST_ENABLED=true.
 *
 * @param {Object} opts
 * @param {Object} opts.app    - Slack Bolt App instance
 * @param {Object} opts.logger - Logger instance
 */
async function start({ app, logger } = {}) {
    if (_started) return;
    _logger = logger;

    const cfg = loadConfig();
    const log = logger || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    // Startup log: channel membership advisory
    const allowedChannels = cfg.slack?.allowed_channels || [];
    log.info(`graph-ingest: starting — allowlist has ${allowedChannels.length} channel(s): ${allowedChannels.join(', ')}`);

    // Bootstrap cache (bulk users.list + conversations.list)
    _cache = new NameCache();
    if (app && app.client) {
        await _cache.bootstrap(app.client, log).catch(err =>
            log.warn(`graph-ingest: cache bootstrap failed (will retry on miss): ${err.message}`)
        );
    }

    // Create buffer + start drain loop
    _buffer = new NdjsonBuffer({
        forwarder: { post: forwarderPost },
        logger: log,
    });
    _buffer.startDrainLoop();

    _started = true;
    log.info('graph-ingest: started');
}

/**
 * Stop the subsystem gracefully.
 */
async function stop() {
    if (!_started) return;
    if (_buffer) _buffer.stopDrainLoop();
    if (_cache) _cache.stop();
    _started = false;
    if (_logger) _logger.info('graph-ingest: stopped');
}

/**
 * Flush the buffer immediately (drain once without waiting for retry interval).
 */
async function flush() {
    if (_buffer) await _buffer.drain();
}

/**
 * Handle a Slack message event.
 * Fire-and-forget from the caller's perspective (< 5 ms hot path).
 *
 * @param {Object} event  - Slack message event
 * @param {Object} client - Slack WebClient
 */
async function handle(event, client) {
    return _handle(event, client, {
        cache: _cache,
        buffer: _buffer,
        logger: _logger,
    });
}

module.exports = { start, stop, flush, handle };
