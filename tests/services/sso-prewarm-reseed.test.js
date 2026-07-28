'use strict';

/**
 * Re-seed coalescing in src/services/sso-prewarm.js.
 *
 * Regression cover for the duplicate-DM bug: every SSO DM carries a
 * "Re-seed now" button and the mint takes seconds, so operators tapped it
 * repeatedly and each tap DM'd its own URL (3 near-identical DMs in 30s on
 * 2026-07-26; recurred 2026-07-27). Guard must collapse the extra taps
 * WITHOUT suppressing a legitimate later re-seed.
 */

const { SsoPrewarm } = require('../../src/services/sso-prewarm');

const COOLDOWN_MS = 60 * 1000;

function freshUrl(n) {
    return {
        verification_url: `https://sso/device?user_code=CODE-${n}`,
        user_code: `CODE-${n}`,
        expires_in: 600,
        reused: false,
    };
}

// Builds an SsoPrewarm with the network + Slack edges stubbed: mintImpl stands
// in for GET /admin/reseed, and the pending-approval file/timer work is a no-op
// so nothing touches disk.
function makeInstance(mintImpl) {
    const posted = [];
    const updated = [];
    const prewarm = new SsoPrewarm({
        url: 'http://127.0.0.1:6789',
        profiles: ['test_profile'],
        intervalMs: 1e9,
        timeoutMs: 1000,
        ownerUserId: 'UOWNER',
        slackClient: {
            chat: {
                postMessage: async (args) => { posted.push(args); return { ok: true }; },
                update: async (args) => { updated.push(args); return { ok: true }; },
            },
        },
    });
    prewarm.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    let mints = 0;
    prewarm._callAdminReseed = async () => { mints += 1; return mintImpl(mints); };
    prewarm._callReseedStatus = async () => ({ sso_token_expires_at: 'T0', sso_token_mtime: 1 });
    prewarm._savePending = () => {};
    prewarm._pollScheduledApproval = () => {};
    return { prewarm, posted, updated, mints: () => mints };
}

describe('SsoPrewarm.reseedNow coalescing', () => {
    test('three sequential taps inside the cooldown mint and DM exactly once', async () => {
        const { prewarm, posted, mints } = makeInstance(freshUrl);

        const first = await prewarm.reseedNow('button');
        const second = await prewarm.reseedNow('button');
        const third = await prewarm.reseedNow('button');

        expect(mints()).toBe(1);
        expect(posted).toHaveLength(1);
        expect(first.dmSent).toBe(true);
        expect([second.coalesced, third.coalesced]).toEqual([true, true]);
        expect([second.dmSent, third.dmSent]).toEqual([false, false]);
        // Coalesced taps still report the live code so the caller can name it.
        expect(second.user_code).toBe('CODE-1');
    });

    test('concurrent taps join the in-flight mint instead of starting their own', async () => {
        const { prewarm, posted, mints } = makeInstance(async (n) => {
            await new Promise(resolve => setTimeout(resolve, 40));
            return freshUrl(n);
        });

        const results = await Promise.all([
            prewarm.reseedNow('button'),
            prewarm.reseedNow('button'),
            prewarm.reseedNow('button'),
        ]);

        expect(mints()).toBe(1);
        expect(posted).toHaveLength(1);
        expect(results.filter(r => r.dmSent)).toHaveLength(1);
        expect(results.filter(r => r.coalesced)).toHaveLength(2);
    });

    test('a reused URL past the cooldown is not DM\'d a second time', async () => {
        // sso_server answers "reusing in-flight URL" with the same code, which
        // is what made DM #2 byte-identical to DM #1 on 2026-07-26.
        const { prewarm, posted } = makeInstance(n => (n === 1
            ? freshUrl(1)
            : { ...freshUrl(1), reused: true }));

        await prewarm.reseedNow('button');
        expect(posted).toHaveLength(1);

        prewarm._lastReseedAt = Date.now() - (COOLDOWN_MS + 1000);
        const again = await prewarm.reseedNow('button');

        expect(posted).toHaveLength(1);
        expect(again.dmSent).toBe(false);
    });

    test('a genuinely new code past the cooldown still gets DM\'d', async () => {
        const { prewarm, posted } = makeInstance(freshUrl);

        await prewarm.reseedNow('button');
        prewarm._lastReseedAt = Date.now() - (COOLDOWN_MS + 1000);
        const again = await prewarm.reseedNow('keyword');

        expect(posted).toHaveLength(2);
        expect(again.dmSent).toBe(true);
        expect(again.user_code).toBe('CODE-2');
    });

    test('tapping the button on a just-sent scheduled DM does not echo its code', async () => {
        const { prewarm, posted } = makeInstance(() => ({ ...freshUrl(9), reused: true }));

        await prewarm._sendScheduledDm(freshUrl(9));
        expect(posted).toHaveLength(1);

        const tapped = await prewarm.reseedNow('button');

        expect(posted).toHaveLength(1);
        expect(tapped.dmSent).toBe(false);
    });

    test('a mint failure propagates and leaves the next tap unblocked', async () => {
        const { prewarm } = makeInstance(() => { throw new Error('boom'); });

        await expect(prewarm.reseedNow('button')).rejects.toThrow('boom');
        expect(prewarm._reseedInFlight).toBeNull();
    });
});

describe('SsoPrewarm.repaintDm', () => {
    test('a note replaces the button with a context line', async () => {
        const { prewarm, updated } = makeInstance(freshUrl);

        await prewarm.repaintDm('D1', '111.0', 'body text', ':hourglass: _working_');

        expect(updated[0].ts).toBe('111.0');
        expect(updated[0].blocks[1].type).toBe('context');
        expect(JSON.stringify(updated[0].blocks)).not.toContain('sso_reseed_now');
    });

    test('a null note restores the Re-seed button for a retry', async () => {
        const { prewarm, updated } = makeInstance(freshUrl);

        await prewarm.repaintDm('D1', '111.0', 'body text', null);

        expect(JSON.stringify(updated[0].blocks)).toContain('sso_reseed_now');
    });

    test('missing ts or text is a no-op rather than a throw', async () => {
        const { prewarm, updated } = makeInstance(freshUrl);

        await prewarm.repaintDm('D1', undefined, 'body', 'note');
        await prewarm.repaintDm('D1', '111.0', '', 'note');

        expect(updated).toHaveLength(0);
    });

    test('a Slack failure is swallowed so it cannot break the re-seed', async () => {
        const { prewarm } = makeInstance(freshUrl);
        prewarm.slackClient.chat.update = async () => { throw new Error('channel_not_found'); };

        await expect(prewarm.repaintDm('D1', '111.0', 'body', 'note')).resolves.toBeUndefined();
        expect(prewarm.logger.debug).toHaveBeenCalled();
    });
});
