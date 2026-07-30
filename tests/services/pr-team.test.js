const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const {
    fetchTeamMembers,
    sweepMyPrs,
    sweepReviewRequests,
    sweepTeamPrs,
} = require('../../src/services/pr-monitor');
const { buildPrBoardBlocks } = require('../../src/channels/slack/pr-board');

const createTasks = () => new PrTasks(new Database(':memory:'));
const jsonOnce = (spy, body) =>
    spy.mockResolvedValueOnce({ ok: true, json: async () => body });

/** The query string handed to /search/issues on call N. */
function queryOf(spy, index = 0) {
    const url = spy.mock.calls[index][0];
    return decodeURIComponent(new URL(url).searchParams.get('q'));
}

describe('fetchTeamMembers', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('returns logins for org/slug', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), [
            { login: 'lei-wego' }, { login: 'mike-wego' },
        ]);
        expect(await fetchTeamMembers('t', 'wego/payments-geeks'))
            .toEqual(['lei-wego', 'mike-wego']);
    });

    test('rejects a malformed team name rather than guessing', async () => {
        await expect(fetchTeamMembers('t', 'payments-geeks'))
            .rejects.toThrow("must be 'org/slug'");
    });
});

describe('org scoping', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('every sweep confines itself to the configured org', async () => {
        const tasks = createTasks();
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, { items: [] });
        await sweepReviewRequests(tasks, 't', { viewerLogin: 'enzo-wego', org: 'wego' });
        expect(queryOf(spy)).toContain('org:wego');

        spy.mockClear();
        jsonOnce(spy, { items: [] });
        await sweepMyPrs(tasks, 't', { org: 'wego' });
        expect(queryOf(spy)).toContain('org:wego');

        spy.mockClear();
        jsonOnce(spy, { items: [] });
        await sweepTeamPrs(tasks, 't', {
            members: ['lei-wego'], viewerLogin: 'enzo-wego', org: 'wego',
        });
        expect(queryOf(spy)).toContain('org:wego');
    });

    test('no org configured leaves the query unscoped', async () => {
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, { items: [] });
        await sweepMyPrs(createTasks(), 't', {});
        expect(queryOf(spy)).not.toContain('org:');
    });
});

describe('sweepTeamPrs', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('ORs the roster minus you, and seeds the team lane', async () => {
        const tasks = createTasks();
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, {
            total_count: 2,
            items: [
                {
                    html_url: 'https://github.com/wego/wego-docs/pull/800',
                    title: 'Shared repo, our team',
                    user: { login: 'lei-wego' },
                },
                {
                    html_url: 'https://github.com/wego/wego-fares/pull/3841',
                    title: 'A repo nobody listed',
                    user: { login: 'mike-wego' },
                },
            ],
        });

        const { seeded, dropped } = await sweepTeamPrs(tasks, 't', {
            members: ['enzo-wego', 'lei-wego', 'mike-wego'],
            viewerLogin: 'enzo-wego',
            org: 'wego',
        });

        const q = queryOf(spy);
        expect(q).toContain('author:lei-wego');
        expect(q).toContain('author:mike-wego');
        expect(q).not.toContain('author:enzo-wego');   // never your own
        expect(seeded).toHaveLength(2);
        expect(dropped).toBe(0);
        expect(tasks.listActive('team')).toHaveLength(2);
        expect(tasks.listActive('team')[0].origin).toBe('github-team');
    });

    test('reports the tail it could not fit on one page', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), {
            total_count: 162,
            items: [{
                html_url: 'https://github.com/wego/payments/pull/1',
                title: 't',
                user: { login: 'lei-wego' },
            }],
        });
        const { dropped } = await sweepTeamPrs(createTasks(), 't', {
            members: ['lei-wego'], viewerLogin: 'enzo-wego', org: 'wego',
        });
        expect(dropped).toBe(161);
    });

    test('a roster of only you makes no request at all', async () => {
        const spy = jest.spyOn(global, 'fetch');
        const result = await sweepTeamPrs(createTasks(), 't', {
            members: ['enzo-wego'], viewerLogin: 'enzo-wego', org: 'wego',
        });
        expect(spy).not.toHaveBeenCalled();
        expect(result).toEqual({ seeded: [], dropped: 0 });
    });

    test('team PRs never become auto-review candidates', async () => {
        const tasks = createTasks();
        tasks.upsert({
            repo: 'wego/payments', number: 2210, url: 'u',
            ci: 'green', reviewState: 'requested', lane: 'team',
        });
        expect(tasks.reviewReady()).toHaveLength(0);
    });
});

describe('lane precedence', () => {
    test('mine outranks review outranks team, whatever the sweep order', () => {
        const tasks = createTasks();
        const row = { repo: 'wego/payments', number: 1, url: 'u' };

        tasks.upsert({ ...row, lane: 'team' });
        expect(tasks.listActive()[0].lane).toBe('team');

        tasks.upsert({ ...row, lane: 'review' });          // promote
        expect(tasks.listActive()[0].lane).toBe('review');

        tasks.upsert({ ...row, lane: 'team' });            // must not demote
        expect(tasks.listActive()[0].lane).toBe('review');

        tasks.upsert({ ...row, lane: 'mine' });            // promote again
        expect(tasks.listActive()[0].lane).toBe('mine');

        tasks.upsert({ ...row, lane: 'review' });          // must not demote
        expect(tasks.listActive()[0].lane).toBe('mine');
    });
});

describe('board renders three lanes', () => {
    test('team rows offer Review/Dismiss/Open via one overflow, never merge', () => {
        const blocks = buildPrBoardBlocks([
            {
                id: 7, lane: 'team', repo: 'wego/wego-docs', number: 800,
                url: 'u', title: 'Shared repo, our team', author: 'lei-wego',
                ci: 'green', status: 'detected',
            },
        ]);
        const text = JSON.stringify(blocks);
        expect(text).toContain('Team PRs');
        expect(text).toContain('@lei-wego');
        expect(text).not.toContain('pr_merge');

        // One block for the whole row: the actions live in its accessory.
        const menu = blocks.find(b => b.accessory?.type === 'overflow').accessory;
        expect(menu.action_id).toBe('pr_menu');
        expect(menu.options.map(o => o.value)).toEqual([
            'pr_review_now:7', 'pr_dismiss:7', 'pr_open:7',
        ]);
    });

    // An empty lane says so, so the board never looks truncated — except the
    // review lane, which vanishes entirely. A header plus "nothing is waiting
    // on you" spent two lines of the Home tab announcing there was no news.
    test('empty own/team lanes say so; an empty review lane renders nothing', () => {
        const text = JSON.stringify(buildPrBoardBlocks([]));
        expect(text).toContain('No open PRs of yours');
        expect(text).toContain('No open PRs from your team');
        expect(text).not.toContain('Needs my review');
        expect(text).not.toContain('Nothing is waiting on you');
    });
});
