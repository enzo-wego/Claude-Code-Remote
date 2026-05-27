'use strict';

/**
 * T07+T08: Tests for src/graph-ingest/buffer.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { NdjsonBuffer, pendingFile, offsetFile, todayStr } = require('../../src/graph-ingest/buffer');

function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-buf-test-'));
    return dir;
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeForwarder(responses = []) {
    let idx = 0;
    return {
        post: jest.fn(async () => {
            if (idx < responses.length) {
                const r = responses[idx++];
                if (r instanceof Error) throw r;
                return r;
            }
            return { ok: true };
        }),
    };
}

describe('NdjsonBuffer: append', () => {
    let dir;
    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('append creates NDJSON file and writes valid JSON line', () => {
        const buf = new NdjsonBuffer({ bufferPath: dir, logger: makeLogger() });
        buf.append({ source: 'slack', body: 'hello' });

        const filePath = pendingFile(dir, todayStr());
        expect(fs.existsSync(filePath)).toBe(true);
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        const record = JSON.parse(lines[0]);
        expect(record.payload.body).toBe('hello');
        expect(record.attempts).toBe(0);
        expect(typeof record.ts).toBe('string');
    });

    test('append multiple payloads → multiple lines', () => {
        const buf = new NdjsonBuffer({ bufferPath: dir, logger: makeLogger() });
        buf.append({ body: 'msg1' });
        buf.append({ body: 'msg2' });
        buf.append({ body: 'msg3' });

        const filePath = pendingFile(dir, todayStr());
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
        expect(lines).toHaveLength(3);
    });

    test('append creates buffer dir if it does not exist', () => {
        const subDir = path.join(dir, 'nested', 'dir');
        const buf = new NdjsonBuffer({ bufferPath: subDir, logger: makeLogger() });
        buf.append({ body: 'test' });
        expect(fs.existsSync(subDir)).toBe(true);
    });
});

describe('NdjsonBuffer: drain', () => {
    let dir;
    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('drain calls forwarder.post for each buffered line and advances offset', async () => {
        const forwarder = makeForwarder();
        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });

        buf.append({ body: 'msg1' });
        buf.append({ body: 'msg2' });

        await buf.drain();

        expect(forwarder.post).toHaveBeenCalledTimes(2);
        expect(forwarder.post.mock.calls[0][0]).toMatchObject({ body: 'msg1' });
        expect(forwarder.post.mock.calls[1][0]).toMatchObject({ body: 'msg2' });

        // Offset should equal file size
        const filePath = pendingFile(dir, todayStr());
        const offPath = offsetFile(dir, todayStr());
        const fileSize = fs.statSync(filePath).size;
        const offset = parseInt(fs.readFileSync(offPath, 'utf8'), 10);
        expect(offset).toBe(fileSize);
    });

    test('drain on 5xx error: stops batch, leaves offset unchanged', async () => {
        const { RetryableError } = require('../../src/graph-ingest/forwarder');
        const err = new RetryableError('status 503');
        const forwarder = makeForwarder([err]); // first call throws retryable

        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });
        buf.append({ body: 'msg1' });
        buf.append({ body: 'msg2' });

        await buf.drain();

        // Only one call attempted (the one that failed)
        expect(forwarder.post).toHaveBeenCalledTimes(1);

        // Offset should still be 0 (not advanced)
        const offPath = offsetFile(dir, todayStr());
        if (fs.existsSync(offPath)) {
            const offset = parseInt(fs.readFileSync(offPath, 'utf8'), 10);
            expect(offset).toBe(0);
        }
    });

    test('drain on 4xx error: skips line, advances offset, continues to next', async () => {
        const { FatalError } = require('../../src/graph-ingest/forwarder');
        const fatalErr = new FatalError('status 400');
        fatalErr.fatal = true;
        const forwarder = makeForwarder([fatalErr]); // first call 4xx, second succeeds

        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });
        buf.append({ body: 'bad' });
        buf.append({ body: 'good' });

        await buf.drain();

        // Both lines processed (skip bad, forward good)
        expect(forwarder.post).toHaveBeenCalledTimes(2);

        // Offset should be at end of file
        const filePath = pendingFile(dir, todayStr());
        const offPath = offsetFile(dir, todayStr());
        const fileSize = fs.statSync(filePath).size;
        const offset = parseInt(fs.readFileSync(offPath, 'utf8'), 10);
        expect(offset).toBe(fileSize);
    });

    test('second drain skips already-forwarded lines (offset respected)', async () => {
        const forwarder = makeForwarder();
        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });

        buf.append({ body: 'msg1' });
        buf.append({ body: 'msg2' });

        await buf.drain(); // forwards both
        expect(forwarder.post).toHaveBeenCalledTimes(2);

        buf.append({ body: 'msg3' }); // new message
        await buf.drain(); // should only forward msg3

        expect(forwarder.post).toHaveBeenCalledTimes(3);
        expect(forwarder.post.mock.calls[2][0]).toMatchObject({ body: 'msg3' });
    });

    test('drain does nothing when no pending file exists', async () => {
        const forwarder = makeForwarder();
        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });
        await buf.drain(); // should not throw
        expect(forwarder.post).not.toHaveBeenCalled();
    });

    test('drain does not run concurrently (_draining guard)', async () => {
        const forwarder = {
            post: jest.fn().mockImplementation(() => new Promise(r => setTimeout(r, 50))),
        };
        const buf = new NdjsonBuffer({ bufferPath: dir, forwarder, logger: makeLogger() });
        buf.append({ body: 'msg1' });

        // Start two concurrent drains
        const p1 = buf.drain();
        const p2 = buf.drain(); // should be a no-op
        await Promise.all([p1, p2]);

        // Only one drain executed
        expect(forwarder.post).toHaveBeenCalledTimes(1);
    });
});

describe('NdjsonBuffer: drain loop', () => {
    test('startDrainLoop and stopDrainLoop do not throw', () => {
        const buf = new NdjsonBuffer({ retryIntervalMs: 60000, logger: makeLogger() });
        buf.startDrainLoop();
        buf.startDrainLoop(); // idempotent
        buf.stopDrainLoop();
        buf.stopDrainLoop(); // idempotent
    });
});
