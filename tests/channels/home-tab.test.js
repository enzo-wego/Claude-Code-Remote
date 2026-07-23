const { buildHomeView } = require('../../src/channels/slack/home-tab');

describe('buildHomeView', () => {
    const now = 1_800_000_000_000;

    test('owner view shows service, sessions with alive markers, queue, schedules', () => {
        const view = buildHomeView({
            isOwner: true,
            uptimeSec: 2 * 24 * 3600 + 14 * 3600, // 2d 14h
            sessions: [
                { name: 'enzobot-a1b2c3', cliType: 'claude', repoPath: '/var/go/src/github.com/payments', alive: true, updatedAt: now - 12 * 60000 },
                { name: 'alert-PD8842', cliType: 'codex', repoPath: '/var/go/src/github.com/tax-service', alive: false, updatedAt: now - 3 * 3600000 },
            ],
            queue: { pending: 0, processing: 1 },
            schedules: { dailySummaryTime: '07:00' },
            now,
        });
        expect(view.type).toBe('home');
        const text = JSON.stringify(view.blocks);
        expect(text).toContain('2d 14h');
        expect(text).toContain('1 live / 2 tracked');
        expect(text).toContain('enzobot-a1b2c3');
        expect(text).toContain('payments');
        expect(text).toContain('0 pending');
        expect(text).toContain('1 processing');
        expect(text).toContain('07:00');
        expect(text).toContain('Coming soon');
    });

    test('non-owner gets the minimal view with no internals', () => {
        const view = buildHomeView({ isOwner: false, uptimeSec: 100, sessions: [{ name: 'secret', alive: true }] });
        const text = JSON.stringify(view.blocks);
        expect(text).not.toContain('secret');
        expect(text).not.toContain('Sessions');
        expect(text).toContain("Enzo's personal agent");
    });

    test('owner view with no sessions renders none placeholder', () => {
        const view = buildHomeView({ isOwner: true, uptimeSec: 60, sessions: [], now });
        expect(JSON.stringify(view.blocks)).toContain('_none_');
    });
});
