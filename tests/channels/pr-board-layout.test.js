const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const { handlePrAction } = require('../../src/channels/slack/pr-actions');
const { sweepTeamPrs } = require('../../src/services/pr-monitor');
const { ageOf, buildPrBoardBlocks } = require('../../src/channels/slack/pr-board');

const DAY = 86_400_000;
const createTasks = () => new PrTasks(new Database(':memory:'));
const headers = blocks => blocks
    .filter(b => b.type === 'header')
    .map(b => b.text.text);

describe('age column', () => {
    const now = Date.parse('2026-07-28T12:00:00Z');
    const at = ms => ageOf({ pr_created_at: ms }, now);

    test('renders compact units and nothing when unknown', () => {
        expect(at(now - 30 * 60_000)).toBe('new');
        expect(at(now - 5 * 3_600_000)).toBe('5h');
        expect(at(now - 3 * DAY)).toBe('3d');
        expect(at(now - 40 * DAY)).toBe('5w');
        expect(ageOf({ pr_created_at: null }, now)).toBe('');
    });
});

describe('section order', () => {
    test('review first, then Team PRs, then My PRs', () => {
        const blocks = buildPrBoardBlocks([
            { id: 1, lane: 'mine', repo: 'a/b', number: 1, url: 'u', ci: 'green', status: 'detected' },
            { id: 2, lane: 'team', repo: 'a/c', number: 2, url: 'u', ci: 'green', status: 'detected', author: 'lei-wego' },
        ]);
        expect(headers(blocks)).toEqual(['PR Review Board', 'Team PRs', 'My PRs']);
    });
});

describe('team lane ordering', () => {
    test('oldest PR first, regardless of insertion order', () => {
        const mk = (id, number, daysOld) => ({
            id, lane: 'team', repo: 'wego/payments', number, url: 'u',
            title: `pr-${number}`, author: 'lei-wego', ci: 'green',
            status: 'detected', pr_created_at: Date.now() - daysOld * DAY,
        });
        const text = JSON.stringify(buildPrBoardBlocks([
            mk(1, 300, 2), mk(2, 100, 21), mk(3, 200, 7),
        ]));
        // 21d oldest → first, then 7d, then 2d
        expect(text.indexOf('#100')).toBeLessThan(text.indexOf('#200'));
        expect(text.indexOf('#200')).toBeLessThan(text.indexOf('#300'));
    });
});

describe('table row shape', () => {
    test('one section per PR with the action as an accessory', () => {
        const blocks = buildPrBoardBlocks([{
            id: 1, lane: 'team', repo: 'wego/payments', number: 2210,
            url: 'https://x/2210', title: 'observability counters',
            author: 'lei-wego', ci: 'green', status: 'detected',
            pr_created_at: Date.now() - 3 * DAY,
        }]);
        const rows = blocks.filter(b => b.type === 'section' && b.accessory);
        expect(rows).toHaveLength(1);
        expect(rows[0].accessory.action_id).toBe('pr_menu');
        // Identity, title, author and age all on one line.
        const line = rows[0].text.text;
        expect(line.split('\n')).toHaveLength(1);
        expect(line).toContain('`wego/payments#2210`');
        expect(line).toContain('@lei-wego');
        expect(line).toContain('3d');
    });

    test('long titles are truncated so rows stay one line', () => {
        const blocks = buildPrBoardBlocks([{
            id: 1, lane: 'team', repo: 'a/b', number: 1, url: 'u',
            title: 'x'.repeat(200), author: 'lei-wego', ci: 'green', status: 'detected',
        }]);
        expect(blocks.find(b => b.accessory).text.text).toContain('…');
    });
});

describe('Dismiss makes a row disappear and stay gone', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    const onBoard = tasks =>
        JSON.stringify(buildPrBoardBlocks(tasks.listActive())).includes('#2210');

    test('dismissed row leaves the board and the next sweep cannot resurrect it', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({
            repo: 'wego/payments', number: 2210, url: 'https://x/2210',
            title: 'observability counters', author: 'lei-wego', lane: 'team',
            prCreatedAt: Date.now() - 3 * DAY,
        });
        expect(onBoard(tasks)).toBe(true);

        const reply = await handlePrAction({
            actionId: 'pr_dismiss', value: String(task.id), prTasks: tasks, jobs: null,
        });
        expect(reply).toContain('Dismissed');
        expect(tasks.get(task.id).status).toBe('dismissed');
        expect(onBoard(tasks)).toBe(false);

        // GitHub still returns it — upsert must not reset `status`.
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                total_count: 1,
                items: [{
                    html_url: 'https://github.com/wego/payments/pull/2210',
                    title: 'observability counters',
                    user: { login: 'lei-wego' },
                    created_at: new Date(Date.now() - 3 * DAY).toISOString(),
                }],
            }),
        });
        await sweepTeamPrs(tasks, 'tok', {
            members: ['lei-wego'], viewerLogin: 'enzo-wego', org: 'wego',
        });

        expect(tasks.get(task.id).status).toBe('dismissed');
        expect(onBoard(tasks)).toBe(false);
    });
});
