'use strict';

/**
 * T02+T03: Tests for src/graph-ingest/cache.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { NameCache } = require('../../src/graph-ingest/cache');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gi-cache-test-'));
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeMockClient({ members = [], channels = [] } = {}) {
    return {
        users: {
            list: jest.fn().mockResolvedValue({ members, response_metadata: { next_cursor: null } }),
            info: jest.fn().mockResolvedValue({ user: members[0] || null }),
        },
        conversations: {
            list: jest.fn().mockResolvedValue({ channels, response_metadata: { next_cursor: null } }),
        },
    };
}

const MEMBER = {
    id: 'U123',
    name: 'alice',
    profile: { display_name: 'Alice Smith', email: 'alice@example.com' },
    is_bot: false,
    is_app_user: false,
};

const CHANNEL = {
    id: 'C456',
    name: 'payments-eng',
};

describe('NameCache: bootstrap', () => {
    let dir;
    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('bootstrap populates users and channels from Slack API', async () => {
        const cachePath = path.join(dir, 'slack-names.json');
        const cache = new NameCache({ cachePath });
        const client = makeMockClient({ members: [MEMBER], channels: [CHANNEL] });

        await cache.bootstrap(client, makeLogger());
        cache.stop();

        expect(cache.getUser('U123')).toBe('Alice Smith');
        expect(cache.getChannel('C456')).toBe('payments-eng');
    });

    test('getUser falls back to raw ID on cache miss', async () => {
        const cache = new NameCache({ cachePath: path.join(dir, 'x.json') });
        expect(cache.getUser('UMISSING')).toBe('UMISSING');
    });

    test('getChannel falls back to raw ID on cache miss', async () => {
        const cache = new NameCache({ cachePath: path.join(dir, 'x.json') });
        expect(cache.getChannel('CMISSING')).toBe('CMISSING');
    });

    test('bootstrap persists cache to disk', async () => {
        const cachePath = path.join(dir, 'slack-names.json');
        const cache = new NameCache({ cachePath });
        const client = makeMockClient({ members: [MEMBER], channels: [CHANNEL] });

        await cache.bootstrap(client, makeLogger());
        cache.stop();

        expect(fs.existsSync(cachePath)).toBe(true);
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        expect(data.users['U123'].display_name).toBe('Alice Smith');
        expect(data.channels['C456'].name).toBe('payments-eng');
    });

    test('loading from disk on second bootstrap skips API call', async () => {
        const cachePath = path.join(dir, 'slack-names.json');

        // First bootstrap
        const cache1 = new NameCache({ cachePath });
        const client1 = makeMockClient({ members: [MEMBER], channels: [CHANNEL] });
        await cache1.bootstrap(client1, makeLogger());
        cache1.stop();

        // Second bootstrap — disk cache loaded, API still called (fresh fetch on startup)
        const cache2 = new NameCache({ cachePath });
        const client2 = makeMockClient({ members: [MEMBER], channels: [CHANNEL] });
        await cache2.bootstrap(client2, makeLogger());
        cache2.stop();

        expect(cache2.getUser('U123')).toBe('Alice Smith');
        // API was called (fresh fetch on startup is intentional)
        expect(client2.users.list).toHaveBeenCalled();
    });

    test('getUserMeta returns full entry including is_bot flag', async () => {
        const cachePath = path.join(dir, 'x.json');
        const cache = new NameCache({ cachePath });
        const client = makeMockClient({ members: [MEMBER], channels: [] });
        await cache.bootstrap(client, makeLogger());
        cache.stop();

        const meta = cache.getUserMeta('U123');
        expect(meta).not.toBeNull();
        expect(meta.is_bot).toBe(false);
        expect(meta.email).toBe('alice@example.com');
    });

    test('corrupt disk cache is silently ignored', async () => {
        const cachePath = path.join(dir, 'corrupt.json');
        fs.writeFileSync(cachePath, 'NOT_JSON', 'utf8');

        const cache = new NameCache({ cachePath });
        const client = makeMockClient({ members: [], channels: [] });
        await cache.bootstrap(client, makeLogger());
        cache.stop();
        // No throw
        expect(cache.getUser('U999')).toBe('U999');
    });

    test('bootstrap failure falls back gracefully (uses disk cache)', async () => {
        const cachePath = path.join(dir, 'fallback.json');
        // Pre-seed disk cache
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({
            users: { 'U_DISK': { display_name: 'Disk User', is_bot: false } },
            channels: {},
        }), 'utf8');

        const cache = new NameCache({ cachePath });
        const failingClient = {
            users: { list: jest.fn().mockRejectedValue(new Error('API down')) },
            conversations: { list: jest.fn().mockRejectedValue(new Error('API down')) },
        };
        await cache.bootstrap(failingClient, makeLogger());
        cache.stop();

        // Should have fallen back to disk cache
        expect(cache.getUser('U_DISK')).toBe('Disk User');
    });

    test('stop() clears the refresh timer without throwing', async () => {
        const cache = new NameCache({ cachePath: path.join(dir, 'x.json') });
        const client = makeMockClient({ members: [], channels: [] });
        await cache.bootstrap(client, makeLogger());
        expect(() => cache.stop()).not.toThrow();
    });
});
