const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const {
    fetchPrState,
    fetchReviewDecision,
    refreshMine,
    reviewQueries,
    sweepMyPrs,
    sweepReviewRequests,
} = require('../../src/services/pr-monitor');
const { needsMyReview } = require('../../src/services/pr-detect');
const { buildMineChangeText } = require('../../src/channels/slack/pr-board');

const createTasks = () => new PrTasks(new Database(':memory:'));

function jsonOnce(spy, body) {
    return spy.mockResolvedValueOnce({ ok: true, json: async () => body });
}

describe('team review requests', () => {
    test('reviewQueries adds one qualifier per team', () => {
        expect(reviewQueries(['wego/payments-geeks', 'wego/platform'])).toEqual([
            'review-requested:@me',
            'team-review-requested:wego/payments-geeks',
            'team-review-requested:wego/platform',
        ]);
    });

    test('reviewQueries alone is just the individual one', () => {
        expect(reviewQueries()).toEqual(['review-requested:@me']);
    });

    test('needsMyReview matches a team request even when you are not named', () => {
        expect(needsMyReview({
            requestedReviewers: ['someone-else'],
            requestedTeams: ['payments-geeks'],
            myTeams: ['wego/payments-geeks'],
            me: 'enzo',
            author: 'alice',
        })).toBe(true);
    });

    test('a team you do not belong to is still not your problem', () => {
        expect(needsMyReview({
            requestedReviewers: [],
            requestedTeams: ['frontend'],
            myTeams: ['wego/payments-geeks'],
            me: 'enzo',
            author: 'alice',
        })).toBe(false);
    });

    test('own PR loses to the team match too', () => {
        expect(needsMyReview({
            requestedTeams: ['payments-geeks'],
            myTeams: ['wego/payments-geeks'],
            me: 'enzo',
            author: 'enzo',
        })).toBe(false);
    });
});

describe('fetchPrState with teams', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('reports requested when only the team is on the hook', async () => {
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, {
            state: 'open',
            merged_at: null,
            title: 'Team-routed change',
            user: { login: 'alice' },
            head: { sha: 'abc' },
            requested_reviewers: [],
            requested_teams: [{ slug: 'payments-geeks' }],
            comments: 1,
            review_comments: 2,
        });
        jsonOnce(spy, { check_runs: [{ status: 'completed', conclusion: 'success' }] });

        const state = await fetchPrState({
            repo: 'wego/payments',
            number: 5,
            token: 't',
            viewerLogin: 'enzo',
            viewerTeams: ['wego/payments-geeks'],
        });

        expect(state.reviewState).toBe('requested');
        expect(state.requestedTeams).toEqual(['payments-geeks']);
        // comments + review_comments, the free activity watermark
        expect(state.comments).toBe(3);
    });
});

describe('fetchReviewDecision', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('changes_requested beats an approval from someone else', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), [
            { user: { login: 'sarah' }, state: 'APPROVED' },
            { user: { login: 'minh' }, state: 'CHANGES_REQUESTED' },
        ]);
        const result = await fetchReviewDecision({
            repo: 'a/b', number: 1, token: 't', viewerLogin: 'enzo',
        });
        expect(result).toEqual({ decision: 'changes_requested', decisionBy: 'minh' });
    });

    test('a reviewer who later approved no longer blocks', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), [
            { user: { login: 'minh' }, state: 'CHANGES_REQUESTED' },
            { user: { login: 'minh' }, state: 'APPROVED' },
        ]);
        const result = await fetchReviewDecision({
            repo: 'a/b', number: 1, token: 't', viewerLogin: 'enzo',
        });
        expect(result).toEqual({ decision: 'approved', decisionBy: 'minh' });
    });

    test('your own review never counts', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), [
            { user: { login: 'enzo' }, state: 'APPROVED' },
        ]);
        const result = await fetchReviewDecision({
            repo: 'a/b', number: 1, token: 't', viewerLogin: 'enzo',
        });
        expect(result).toEqual({ decision: null, decisionBy: null });
    });

    test('comments alone report as commented', async () => {
        jsonOnce(jest.spyOn(global, 'fetch'), [
            { user: { login: 'sarah' }, state: 'COMMENTED' },
        ]);
        const result = await fetchReviewDecision({
            repo: 'a/b', number: 1, token: 't', viewerLogin: 'enzo',
        });
        expect(result).toEqual({ decision: 'commented', decisionBy: 'sarah' });
    });
});

describe('sweepMyPrs', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('seeds your own PRs into the mine lane', async () => {
        const tasks = createTasks();
        jsonOnce(jest.spyOn(global, 'fetch'), {
            items: [{
                html_url: 'https://github.com/wego/payments/pull/412',
                title: 'Fix tax rounding',
                user: { login: 'enzo' },
            }],
        });

        await sweepMyPrs(tasks, 'token');

        expect(tasks.listActive('mine')).toHaveLength(1);
        expect(tasks.listActive('review')).toHaveLength(0);
        expect(tasks.listActive('mine')[0]).toEqual(expect.objectContaining({
            lane: 'mine',
            origin: 'github-mine',
        }));
    });

    test('own PRs never reach the auto-review queue', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'u',
            ci: 'green',
            reviewState: 'requested',
            lane: 'mine',
        });
        expect(tasks.get(task.id).ci).toBe('green');
        expect(tasks.reviewReady()).toHaveLength(0);
    });
});

describe('refreshMine', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    function mockCycle(spy, { pull, reviews }) {
        jsonOnce(spy, pull);
        jsonOnce(spy, { check_runs: [{ status: 'completed', conclusion: 'success' }] });
        jsonOnce(spy, reviews);
    }

    const basePull = {
        state: 'open',
        merged_at: null,
        title: 'Fix tax rounding',
        user: { login: 'enzo' },
        head: { sha: 'abc' },
        requested_reviewers: [],
        comments: 0,
        review_comments: 0,
    };

    test('first sighting records state but reports nothing', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({ repo: 'a/b', number: 1, url: 'u', lane: 'mine' });
        mockCycle(jest.spyOn(global, 'fetch'), {
            pull: { ...basePull, comments: 4 },
            reviews: [{ user: { login: 'sarah' }, state: 'APPROVED' }],
        });

        const changed = await refreshMine(tasks, 'token', 'enzo');

        expect(changed).toHaveLength(0);
        expect(tasks.get(task.id)).toEqual(expect.objectContaining({
            review_decision: 'approved',
            decision_by: 'sarah',
            seen_comments: 4,
        }));
    });

    test('an approval after a known state is reported once', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({ repo: 'a/b', number: 1, url: 'u', lane: 'mine' });
        tasks.setMineState(task.id, { seenComments: 0 });

        const spy = jest.spyOn(global, 'fetch');
        mockCycle(spy, {
            pull: basePull,
            reviews: [{ user: { login: 'sarah' }, state: 'APPROVED' }],
        });
        const first = await refreshMine(tasks, 'token', 'enzo');
        expect(first).toHaveLength(1);
        expect(first[0].decision).toBe('approved');
        expect(first[0].decisionBy).toBe('sarah');

        // Same state next cycle — silence.
        mockCycle(spy, {
            pull: basePull,
            reviews: [{ user: { login: 'sarah' }, state: 'APPROVED' }],
        });
        expect(await refreshMine(tasks, 'token', 'enzo')).toHaveLength(0);
    });

    test('new comments alone count as movement', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({ repo: 'a/b', number: 1, url: 'u', lane: 'mine' });
        tasks.setMineState(task.id, { seenComments: 2 });

        mockCycle(jest.spyOn(global, 'fetch'), {
            pull: { ...basePull, comments: 3, review_comments: 2 },
            reviews: [],
        });

        const changed = await refreshMine(tasks, 'token', 'enzo');
        expect(changed).toHaveLength(1);
        expect(changed[0].newComments).toBe(3);
        expect(tasks.get(task.id).seen_comments).toBe(5);
    });

    test('a merged PR leaves the board', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({ repo: 'a/b', number: 1, url: 'u', lane: 'mine' });
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, { ...basePull, state: 'closed', merged_at: '2026-07-28T00:00:00Z' });
        jsonOnce(spy, { check_runs: [] });

        await refreshMine(tasks, 'token', 'enzo');

        expect(tasks.get(task.id).status).toBe('closed');
        expect(tasks.listActive('mine')).toHaveLength(0);
    });
});

describe('buildMineChangeText', () => {
    test('names the approver', () => {
        const text = buildMineChangeText({
            task: { repo: 'wego/payments', number: 412, url: 'u', title: 'Fix tax rounding' },
            decision: 'approved',
            decisionBy: 'sarah',
            decisionChanged: true,
            newComments: 0,
        });
        expect(text).toContain('@sarah approved');
        expect(text).toContain('wego/payments#412');
    });

    test('falls back to a comment count when the decision did not move', () => {
        const text = buildMineChangeText({
            task: { repo: 'wego/payments', number: 412, url: 'u', title: 't' },
            decision: 'approved',
            decisionBy: 'sarah',
            decisionChanged: false,
            newComments: 1,
        });
        expect(text).toContain('1 new comment on');
    });
});

describe('sweepReviewRequests own-PR guard', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('a team-requested PR you authored goes nowhere near the review lane', async () => {
        const tasks = createTasks();
        // team-review-requested: can return your own PR — review-requested:@me
        // never could, so this guard only became necessary with team queries.
        jsonOnce(jest.spyOn(global, 'fetch'), {
            items: [{
                html_url: 'https://github.com/wego/payments/pull/2206',
                title: 'PAY-2208: Train tax product codes',
                user: { login: 'enzo' },
            }],
        });

        const seeded = await sweepReviewRequests(tasks, 'token', {
            teams: ['wego/payments-geeks'],
            viewerLogin: 'enzo',
        });

        expect(seeded).toHaveLength(0);
        expect(tasks.listActive()).toHaveLength(0);
        expect(tasks.reviewReady()).toHaveLength(0);
    });

    test("a teammate's team-requested PR is still seeded", async () => {
        const tasks = createTasks();
        const spy = jest.spyOn(global, 'fetch');
        jsonOnce(spy, { items: [] });                       // review-requested:@me
        jsonOnce(spy, {                                     // team-review-requested
            items: [{
                html_url: 'https://github.com/wego/payments/pull/2207',
                title: 'Someone else work',
                user: { login: 'alice' },
            }],
        });

        const seeded = await sweepReviewRequests(tasks, 'token', {
            teams: ['wego/payments-geeks'],
            viewerLogin: 'enzo',
        });

        expect(seeded).toHaveLength(1);
        expect(tasks.listActive('review')).toHaveLength(1);
    });
});
