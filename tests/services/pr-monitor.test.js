const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const {
    mapCiState,
    refreshAll,
} = require('../../src/services/pr-monitor');

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
        const fetchMock = jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    title: 'Fix tax rounding',
                    user: { login: 'alice' },
                    head: { sha: 'abc123' },
                    requested_reviewers: [{ login: 'enzo' }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    check_runs: [
                        { status: 'completed', conclusion: 'success' },
                    ],
                }),
            });

        const ready = await refreshAll(tasks, 'token');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(tasks.get(task.id)).toEqual(expect.objectContaining({
            ci: 'green',
            review_state: 'requested',
            title: 'Fix tax rounding',
            author: 'alice',
        }));
        expect(ready.map(row => row.id)).toEqual([task.id]);
    });
});
