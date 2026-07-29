const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const {
    fetchPrState,
    mapCiState,
    refreshAll,
    sweepReviewRequests,
} = require('../../src/services/pr-monitor');

const createTasks = () => new PrTasks(new Database(':memory:'));

describe('mapCiState', () => {
    test('maps all-success checks to green', () => {
        expect(mapCiState([
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'success' },
        ])).toBe('green');
    });

    test('maps any failure to red', () => {
        expect(mapCiState([
            { status: 'in_progress', conclusion: null },
            { status: 'completed', conclusion: 'failure' },
        ])).toBe('red');
    });

    test('maps any pending check to pending', () => {
        expect(mapCiState([
            { status: 'completed', conclusion: 'success' },
            { status: 'in_progress', conclusion: null },
        ])).toBe('pending');
    });
});

describe('refreshAll', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('refreshes active PRs and returns tasks newly ready for review', async () => {
        const tasks = new PrTasks(new Database(':memory:'));
        const task = tasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
            ci: 'pending',
            reviewState: 'requested',
        });
        // Routed by URL: the decision and the activity timeline share a
        // Promise.all, so their relative order is not a contract.
        const fetchMock = jest.spyOn(global, 'fetch')
            .mockImplementation(async (url) => {
                const body = /check-runs/.test(url)
                    ? { check_runs: [{ status: 'completed', conclusion: 'success' }] }
                    : /\/pulls\/\d+\/reviews/.test(url)
                        ? [{
                            user: { login: 'bob', type: 'User' },
                            state: 'APPROVED',
                            submitted_at: '2026-07-29T02:00:00Z',
                        }]
                        : /comments/.test(url) ? []
                            : {
                                title: 'Fix tax rounding',
                                user: { login: 'alice' },
                                head: { sha: 'abc123' },
                                requested_reviewers: [{ login: 'enzo' }],
                            };
                return { ok: true, json: async () => body };
            });

        const ready = await refreshAll(tasks, 'token');

        // pull + check-runs + reviews(decision) + the three the activity
        // timeline needs: issue comments, inline comments, reviews.
        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(tasks.get(task.id)).toEqual(expect.objectContaining({
            ci: 'green',
            review_state: 'requested',
            title: 'Fix tax rounding',
            author: 'alice',
            review_decision: 'approved',
            decision_by: 'bob',
            // Approved outranks whoever spoke last.
            turn: 'done',
        }));
        expect(ready.map(row => row.id)).toEqual([task.id]);
    });
});

describe('closed PRs leave the board', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    function mockPull(pull) {
        return jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({ ok: true, json: async () => pull })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    check_runs: [{ status: 'completed', conclusion: 'success' }],
                }),
            });
    }

    test('fetchPrState reports closed and merged', async () => {
        mockPull({
            state: 'closed',
            merged_at: '2026-07-28T06:37:19Z',
            title: 't',
            user: { login: 'alice' },
            head: { sha: 'abc' },
            requested_reviewers: [],
        });
        const state = await fetchPrState({ repo: 'a/b', number: 1, token: 't' });
        expect(state.closed).toBe(true);
        expect(state.merged).toBe(true);
    });

    test('refreshAll retires a closed PR so it drops off listActive', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({
            repo: 'a/b', number: 9, url: 'u', ci: 'green', reviewState: 'requested',
        });
        expect(tasks.listActive()).toHaveLength(1);

        mockPull({
            state: 'closed',
            merged_at: null,
            title: 't',
            user: { login: 'alice' },
            head: { sha: 'abc' },
            requested_reviewers: [{ login: 'enzo' }],
        });
        await refreshAll(tasks, 'token');

        expect(tasks.get(task.id).status).toBe('closed');
        expect(tasks.listActive()).toHaveLength(0);
        expect(tasks.reviewReady()).toHaveLength(0);
    });

    test('reviewState is scoped to the owner when viewerLogin is known', async () => {
        mockPull({
            state: 'open', merged_at: null, title: 't',
            user: { login: 'alice' }, head: { sha: 'abc' },
            requested_reviewers: [{ login: 'someone-else' }],
        });
        const mine = await fetchPrState({
            repo: 'a/b', number: 1, token: 't', viewerLogin: 'enzo',
        });
        // Another reviewer being pending is not my queue.
        expect(mine.reviewState).toBe('none');
    });
});

describe('sweepReviewRequests', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    test('seeds PRs awaiting review from the GitHub search API', async () => {
        const tasks = createTasks();
        jest.spyOn(global, 'fetch').mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                items: [
                    {
                        html_url: 'https://github.com/wego/payments/pull/412',
                        title: 'Fix refund flow',
                        user: { login: 'sarah' },
                    },
                    { html_url: 'https://not-a-pr.example/x', title: 'ignore me' },
                ],
            }),
        });

        const seeded = await sweepReviewRequests(tasks, 'token');

        expect(seeded).toHaveLength(1);
        expect(tasks.listActive()).toHaveLength(1);
        expect(tasks.listActive()[0]).toEqual(expect.objectContaining({
            repo: 'wego/payments',
            number: 412,
            review_state: 'requested',
            origin: 'github-sweep',
        }));
    });

    test('does not resurrect a PR the owner already dismissed', async () => {
        const tasks = createTasks();
        const task = tasks.upsert({ repo: 'wego/payments', number: 412, url: 'u' });
        tasks.setStatus(task.id, 'dismissed');

        jest.spyOn(global, 'fetch').mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                items: [{
                    html_url: 'https://github.com/wego/payments/pull/412',
                    title: 'Fix refund flow',
                    user: { login: 'sarah' },
                }],
            }),
        });
        await sweepReviewRequests(tasks, 'token');

        expect(tasks.get(task.id).status).toBe('dismissed');
        expect(tasks.listActive()).toHaveLength(0);
    });
});
