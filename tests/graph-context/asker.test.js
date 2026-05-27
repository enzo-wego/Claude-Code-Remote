/**
 * T08: AskerLookup unit tests — verifies TTL cache behaviour.
 */

const { AskerLookup } = require('../../src/graph-context/asker');

describe('AskerLookup', () => {
    test('eeidForSlackUid caches results', async () => {
        let calls = 0;
        const fake = { node: async () => { calls++; return { eeid: 982 }; } };
        const a = new AskerLookup({ client: fake, ttlMs: 1000 });
        expect(await a.eeidForSlackUid('U1')).toBe(982);
        expect(await a.eeidForSlackUid('U1')).toBe(982);
        expect(calls).toBe(1);
    });

    test('returns 0 for missing uid', async () => {
        const fake = { node: async () => null };
        const a = new AskerLookup({ client: fake, ttlMs: 1000 });
        expect(await a.eeidForSlackUid(null)).toBe(0);
    });

    test('returns 0 when node has no eeid', async () => {
        const fake = { node: async () => ({ title: 'person' }) };
        const a = new AskerLookup({ client: fake, ttlMs: 1000 });
        expect(await a.eeidForSlackUid('U2')).toBe(0);
    });
});
