'use strict';

/**
 * T13: Integration test — fake Slack message event → buffer → forwarder → mock agent-mem HTTP server.
 *
 * No real agent-mem or Docker needed. Uses Node's built-in http.createServer.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { handle } = require('../../src/graph-ingest/handler');
const { NdjsonBuffer } = require('../../src/graph-ingest/buffer');
const { post: forwarderPost } = require('../../src/graph-ingest/forwarder');
const { NameCache } = require('../../src/graph-ingest/cache');
const { loadConfig, _resetConfig } = require('../../src/graph-ingest/config-loader');

// ─── Mock HTTP server ─────────────────────────────────────────────────────────

function startMockServer() {
    const received = [];
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/graph/ingest/content') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    received.push(JSON.parse(body));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch {
                    res.writeHead(400);
                    res.end();
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, received });
        });
    });
}

function stopServer(server) {
    return new Promise(resolve => server.close(resolve));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gi-integ-test-'));
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeCache(users = {}) {
    const c = new NameCache({ cachePath: '/dev/null' });
    for (const [id, display_name] of Object.entries(users)) {
        c.users.set(id, { display_name, is_bot: false, email: null, updated_at: Date.now() });
    }
    return c;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Integration: Slack message → buffer → mock agent-mem', () => {
    let server, port, received, dir;

    beforeAll(async () => {
        ({ server, port, received } = await startMockServer());
        dir = makeTmpDir();
    });

    afterAll(async () => {
        await stopServer(server);
        fs.rmSync(dir, { recursive: true, force: true });
        _resetConfig();
    });

    beforeEach(() => {
        received.length = 0;
        _resetConfig();
        // Point config loader to test config (allowed channel C05RNSE8TBR is in the default yaml)
    });

    test('message in allowed channel → buffered → drained → received by mock server', async () => {
        const logger = makeLogger();
        const cache = makeCache({ U02FKR154T1: 'Alexandre Morin' });

        // Buffer wired to our mock server
        const buf = new NdjsonBuffer({
            bufferPath: dir,
            forwarder: {
                post: (payload) => forwarderPost(payload, {
                    url: `http://127.0.0.1:${port}`,
                    apiKey: 'test-key',
                }),
            },
            logger,
        });

        const event = {
            type: 'message',
            channel: 'C05RNSE8TBR',
            user: 'U02FKR154T1',
            text: '<@U02FKR154T1> TRY split needed — see <https://jira.wego.com/browse/PAY-123|PAY-123>',
            ts: '1779711855.864859',
            thread_ts: '1779710997.630059',
        };

        // Handle the event (filter + normalize + buffer)
        await handle(event, null, { cache, buffer: buf, logger });

        // Drain the buffer to the mock server
        await buf.drain();

        // Assert payload was received
        expect(received).toHaveLength(1);
        const payload = received[0];

        expect(payload.source).toBe('slack');
        expect(payload.canonical_url).toContain('C05RNSE8TBR');
        expect(payload.canonical_url).toContain('1779711855864859');
        expect(payload.body).toContain('@Alexandre Morin');
        expect(payload.body).toContain('PAY-123');
        expect(payload.metadata.channel_id).toBe('C05RNSE8TBR');
        expect(payload.metadata.ts).toBe('1779711855.864859');
        expect(payload.metadata.thread_ts).toBe('1779710997.630059');
        expect(payload.metadata.author.ref).toBe('slack_uid:U02FKR154T1');
        expect(payload.metadata.author.display_name).toBe('Alexandre Morin');
        expect(Array.isArray(payload.metadata.mentions)).toBe(true);
        expect(payload.metadata.scope).toBe('slack:C05RNSE8TBR');
    });

    test('message in non-allowed channel is filtered, nothing sent to mock server', async () => {
        const logger = makeLogger();
        const cache = makeCache();
        const buf = new NdjsonBuffer({
            bufferPath: dir,
            forwarder: {
                post: (payload) => forwarderPost(payload, { url: `http://127.0.0.1:${port}`, apiKey: 'test-key' }),
            },
            logger,
        });

        const event = {
            channel: 'COTHER_NOT_ALLOWED',
            user: 'U_HUMAN',
            text: 'this should be dropped',
            ts: '111.111',
        };

        await handle(event, null, { cache, buffer: buf, logger });
        await buf.drain();

        expect(received).toHaveLength(0);
    });

    test('bot-self message is filtered, nothing sent', async () => {
        const logger = makeLogger();
        const cache = makeCache();
        const buf = new NdjsonBuffer({
            bufferPath: dir,
            forwarder: {
                post: (payload) => forwarderPost(payload, { url: `http://127.0.0.1:${port}`, apiKey: 'test-key' }),
            },
            logger,
        });

        const origBotId = process.env.ENZOBOT_USER_ID;
        process.env.ENZOBOT_USER_ID = 'U0AG1DJP9K9';

        const event = {
            channel: 'C05RNSE8TBR',
            user: 'U0AG1DJP9K9', // EnzoBot itself
            text: 'bot self message',
            ts: '222.222',
        };

        await handle(event, null, { cache, buffer: buf, logger });
        await buf.drain();

        process.env.ENZOBOT_USER_ID = origBotId;
        expect(received).toHaveLength(0);
    });

    test('message with files: file metadata included in payload', async () => {
        const logger = makeLogger();
        const cache = makeCache();
        const buf = new NdjsonBuffer({
            bufferPath: dir,
            forwarder: {
                post: (payload) => forwarderPost(payload, { url: `http://127.0.0.1:${port}`, apiKey: 'test-key' }),
            },
            logger,
        });

        const event = {
            channel: 'C05RNSE8TBR',
            user: 'U_HUMAN',
            text: 'see screenshot',
            ts: '333.333',
            files: [{
                id: 'F0B5TLXQLTV',
                mimetype: 'image/png',
                name: 'screenshot.png',
                size: 248312,
                url_private: 'https://files.slack.com/...',
                thumb_360: 'https://files.slack.com/thumb',
            }],
        };

        await handle(event, null, { cache, buffer: buf, logger });
        await buf.drain();

        expect(received).toHaveLength(1);
        const files = received[0].metadata.files;
        expect(files).toHaveLength(1);
        expect(files[0].id).toBe('F0B5TLXQLTV');
        expect(files[0].mimetype).toBe('image/png');
    });

    test('5xx from server: offset not advanced, message remains in buffer for retry', async () => {
        const logger = makeLogger();
        const cache = makeCache();

        // Use a separate tmp dir so offset is fresh
        const errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-5xx-'));

        let callCount = 0;
        const buf = new NdjsonBuffer({
            bufferPath: errDir,
            forwarder: {
                post: async () => {
                    callCount++;
                    const { RetryableError } = require('../../src/graph-ingest/forwarder');
                    throw new RetryableError('status 503');
                },
            },
            logger,
        });

        const event = {
            channel: 'C05RNSE8TBR',
            user: 'U_HUMAN',
            text: 'message during outage',
            ts: '444.444',
        };

        await handle(event, null, { cache, buffer: buf, logger });
        await buf.drain();

        // Exactly one attempt (stopped after first retryable error)
        expect(callCount).toBe(1);

        // Offset file should be 0 or not exist (not advanced)
        const { offsetFile, todayStr } = require('../../src/graph-ingest/buffer');
        const offPath = offsetFile(errDir, todayStr());
        if (fs.existsSync(offPath)) {
            expect(parseInt(fs.readFileSync(offPath, 'utf8'), 10)).toBe(0);
        }

        fs.rmSync(errDir, { recursive: true, force: true });
    });
});
