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
        expect(headers(blocks)).toEqual(['Needs my review', 'Team PRs', 'My PRs']);
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

    test('an approved team PR leads with the approval glyph, not CI', () => {
        const blocks = buildPrBoardBlocks([{
            id: 1, lane: 'team', repo: 'wego/payments-knowledge', number: 6,
            url: 'u', title: 'use fresh refs', author: 'yanyi-wego',
            ci: 'pending', status: 'detected',
            review_decision: 'approved', decision_by: 'lei-wego',
        }]);
        const line = blocks.find(b => b.accessory).text.text;
        expect(line.startsWith('✅')).toBe(true);
        expect(line).toContain('approved @lei-wego');
        // CI is still visible, just demoted to a column.
        expect(line).toContain('CI 🟡');
    });

    test('a team PR nobody has reviewed still leads with CI', () => {
        const blocks = buildPrBoardBlocks([{
            id: 1, lane: 'team', repo: 'a/b', number: 1, url: 'u',
            title: 't', author: 'lei-wego', ci: 'red', status: 'detected',
        }]);
        const line = blocks.find(b => b.accessory).text.text;
        expect(line.startsWith('🔴')).toBe(true);
        expect(line).toContain('no review');
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

describe('bounded concurrency', () => {
    const { mapLimit } = require('../../src/services/pr-monitor');

    test('covers every item and never exceeds the limit', async () => {
        const items = Array.from({ length: 23 }, (_, i) => i);
        const seen = [];
        let inFlight = 0;
        let peak = 0;

        await mapLimit(items, 5, async item => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 1));
            seen.push(item);
            inFlight -= 1;
        });

        expect(seen.sort((a, b) => a - b)).toEqual(items);
        expect(peak).toBeLessThanOrEqual(5);
        expect(peak).toBeGreaterThan(1);
    });

    test('an empty list starts no runners', async () => {
        let called = false;
        await mapLimit([], 5, async () => { called = true; });
        expect(called).toBe(false);
    });
});

describe('draft handling', () => {
    test('draft status is recorded, and preferences round-trip', () => {
        const tasks = createTasks();
        const draft = tasks.upsert({
            repo: 'wego/payments', number: 2200, url: 'u',
            lane: 'mine', isDraft: true,
        });
        const ready = tasks.upsert({
            repo: 'wego/payments', number: 2206, url: 'u',
            lane: 'mine', isDraft: false,
        });
        expect(tasks.get(draft.id).is_draft).toBe(1);
        expect(tasks.get(ready.id).is_draft).toBe(0);

        // A later sweep that omits the flag must not silently clear it.
        tasks.upsert({ repo: 'wego/payments', number: 2200, url: 'u', lane: 'mine' });
        expect(tasks.get(draft.id).is_draft).toBe(1);

        expect(tasks.getPref('show_drafts', 'false')).toBe('false');
        tasks.setPref('show_drafts', 'true');
        expect(tasks.getPref('show_drafts', 'false')).toBe('true');
        tasks.setPref('show_drafts', 'false');
        expect(tasks.getPref('show_drafts', 'false')).toBe('false');
    });
});

describe('a dead review returns the row to actionable', () => {
    test('failDraft clears the job link and restores the Review now button', () => {
        const tasks = createTasks();
        const task = tasks.upsert({
            repo: 'wego/payments-knowledge', number: 6, url: 'https://x/6',
            title: 'use fresh refs', author: 'yanyi-wego', lane: 'review',
            reviewState: 'requested', ci: 'green',
        });

        tasks.setDraftJob(task.id, 42);
        expect(tasks.get(task.id).status).toBe('reviewing');
        let json = JSON.stringify(buildPrBoardBlocks(tasks.listActive()));
        expect(json).not.toContain('pr_review_now');

        tasks.failDraft(task.id);

        const reset = tasks.get(task.id);
        expect(reset.status).toBe('detected');
        expect(reset.draft_job_id).toBeNull();
        json = JSON.stringify(buildPrBoardBlocks(tasks.listActive()));
        expect(json).toContain('pr_review_now');
    });
});
