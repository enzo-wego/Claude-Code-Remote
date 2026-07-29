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
            prTasks: [{
                id: 1,
                repo: 'wego/payments',
                number: 412,
                url: 'https://github.com/wego/payments/pull/412',
                title: 'Fix tax rounding',
                ci: 'green',
                review_state: 'requested',
                status: 'needs_review',
            }],
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
        expect(text).toContain('Needs my review');
        expect(text).toContain('Fix tax rounding');
        const boardIndex = view.blocks.findIndex(block =>
            block.type === 'header'
            && block.text.text === 'Needs my review'
        );
        const serviceIndex = view.blocks.findIndex(block =>
            block.type === 'section'
            && block.text.text.startsWith('*Service*')
        );
        expect(boardIndex).toBeLessThan(serviceIndex);
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

describe('page-level controls', () => {
    const now = 1_800_000_000_000;
    const owner = extra => buildHomeView({
        isOwner: true, uptimeSec: 60, sessions: [], now, ...extra,
    });

    test('Refresh and the drafts toggle are the first thing on the page', () => {
        const view = owner();
        // Controls are page-scoped, not board-scoped: this page grows more
        // sections and one Refresh must cover all of them. They lead the view —
        // Slack's own tab chrome already names the app, so no title block.
        const controls = view.blocks[0];
        expect(controls.type).toBe('actions');
        expect(controls.elements.map(e => e.action_id))
            .toEqual(['home_refresh', 'home_toggle_drafts']);
        expect(JSON.stringify(view.blocks)).not.toContain('live status');

        const firstLane = view.blocks.findIndex(b => b.type === 'header' && b.text.text === 'Team PRs');
        expect(firstLane).toBeGreaterThan(0);
    });

    test('freshness line renders in the viewer timezone', () => {
        const ctx = owner().blocks.find(b => b.type === 'context');
        expect(ctx.elements[0].text).toContain(`<!date^${now / 1000}^`);
        expect(ctx.elements[0].text).toContain('updated');
    });

    test('says so while a refresh is in flight', () => {
        const ctx = owner({ refreshing: true }).blocks.find(b => b.type === 'context');
        expect(ctx.elements[0].text).toContain('refreshing from GitHub');
    });

    test('toggle label and value invert with the current state', () => {
        const hidden = owner({ showDrafts: false }).blocks[0].elements[1];
        expect(hidden.text.text).toContain('Drafts: hidden');
        expect(hidden.value).toBe('show');

        const shown = owner({ showDrafts: true }).blocks[0].elements[1];
        expect(shown.text.text).toContain('Drafts: shown');
        expect(shown.value).toBe('hide');
    });

    test('reports how many drafts were withheld', () => {
        const ctx = owner({ draftsHidden: 5 }).blocks.find(b => b.type === 'context');
        expect(ctx.elements[0].text).toContain('5 draft(s) hidden');
    });
});
