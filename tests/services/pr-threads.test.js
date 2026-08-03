const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const {
    countOpenThreads,
    fetchReviewThreads,
    turnFor,
} = require('../../src/services/pr-monitor');
const {
    buildPrBoardBlocks,
    turnOf,
} = require('../../src/channels/slack/pr-board');

function thread({
    resolved = false,
    outdated = false,
    author = 'coderabbitai',
    comments,
} = {}) {
    const nodes = comments === undefined
        ? [{
            author: author === null ? null : { login: author },
            createdAt: '2026-07-30T01:00:00Z',
        }]
        : comments;
    return {
        isResolved: resolved,
        isOutdated: outdated,
        path: 'src/payment.js',
        line: 42,
        comments: { nodes },
    };
}

function graphqlBody(nodes) {
    return {
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: { nodes },
                },
            },
        },
    };
}

function mineTask(extra = {}) {
    return {
        id: 1,
        lane: 'mine',
        repo: 'wego/payments-react-component',
        number: 458,
        url: 'https://github.com/wego/payments-react-component/pull/458',
        title: 'Keep the selected payment method',
        author: 'enzo-wego',
        status: 'detected',
        ci: 'green',
        review_decision: 'approved',
        decision_by: 'reviewer',
        turn: 'done',
        ...extra,
    };
}

describe('countOpenThreads', () => {
    test('counts the three live unanswered threads in the PR 458 fixture', () => {
        const nodes = [
            ...Array.from({ length: 8 }, () => thread({ resolved: true })),
            thread({ outdated: true, author: 'enzo-wego' }),
            ...Array.from({ length: 3 }, () => thread()),
        ];

        expect(countOpenThreads(nodes, 'enzo-wego')).toBe(3);
    });

    test('does not count a resolved thread whose last author is someone else', () => {
        expect(countOpenThreads([
            thread({ resolved: true, author: 'coderabbitai' }),
        ], 'enzo-wego')).toBe(0);
    });

    test('does not count an unresolved outdated thread', () => {
        expect(countOpenThreads([
            thread({ outdated: true, author: 'coderabbitai' }),
        ], 'enzo-wego')).toBe(0);
    });

    test('compares the last author to the viewer case-insensitively', () => {
        expect(countOpenThreads([
            thread({ author: 'Enzo-Wego' }),
        ], 'enzo-wego')).toBe(0);
    });

    test('fails visible when a thread has no readable comments', () => {
        expect(countOpenThreads([
            thread({ comments: [] }),
        ], 'enzo-wego')).toBe(1);
    });

    test('fails visible when the last author account was deleted', () => {
        expect(countOpenThreads([
            thread({ author: null }),
        ], 'enzo-wego')).toBe(1);
    });

    test('always returns a number for a malformed collection', () => {
        expect(countOpenThreads(null, 'enzo-wego')).toBe(0);
    });

    // Both callers resolve the viewer through a `.catch(() => null)`, so this
    // arrives in production, not just in tests. Comparing against '' would make
    // every live thread somebody else's and turn the entire board yellow.
    test('an unknown viewer yields an unknown count, not every thread', () => {
        const nodes = [
            thread({ author: 'enzo-wego' }),
            thread({ author: 'coderabbitai' }),
        ];
        expect(countOpenThreads(nodes, null)).toBeNull();
        expect(countOpenThreads(nodes, '')).toBeNull();
        expect(countOpenThreads(nodes, 'enzo-wego')).toBe(1);
    });
});

describe('turn ignores the open-thread count entirely', () => {
    // turnFor no longer takes open threads into account. Each row is asserted
    // with openThreads 0 and 3 in the argument object: both are ignored today,
    // so re-introducing the parameter makes the `3` variant start failing.
    const cases = [
        { case: 1, author: 'enzo-wego', lastSpeaker: 'enzo-wego', decision: undefined, expected: 'theirs' },
        { case: 2, author: 'enzo-wego', lastSpeaker: 'reviewer', decision: 'approved', expected: 'done' },
        { case: 3, author: 'enzo-wego', lastSpeaker: 'reviewer', decision: undefined, expected: 'mine' },
        { case: 4, author: 'teammate', lastSpeaker: 'teammate', decision: undefined, expected: 'mine' },
        { case: 5, author: 'teammate', lastSpeaker: 'teammate', decision: 'approved', expected: 'done' },
        { case: 5, author: 'teammate', lastSpeaker: 'enzo-wego', decision: undefined, expected: 'theirs' },
        // The gaps the five rules leave open, which must not regress.
        { case: 'fresh review request', author: 'teammate', lastSpeaker: null, decision: undefined, expected: 'mine' },
        { case: 'own PR, nobody spoke', author: 'enzo-wego', lastSpeaker: null, decision: undefined, expected: 'theirs' },
    ];

    for (const row of cases) {
        for (const openThreads of [0, 3]) {
            const name = `case ${row.case}: ${row.author}/${row.lastSpeaker}`
                + `${row.decision ? `/${row.decision}` : ''} → ${row.expected}`
                + ` (open_threads: ${openThreads})`;
            test(name, () => {
                expect(turnFor({
                    decision: row.decision,
                    author: row.author,
                    lastSpeaker: row.lastSpeaker,
                    viewerLogin: 'enzo-wego',
                    openThreads,
                })).toBe(row.expected);
            });
        }
    }

    test('turnOf surfaces the stored turn verbatim for any open_threads value', () => {
        for (const open_threads of [0, 3, null, undefined]) {
            expect(turnOf(mineTask({ turn: 'done', open_threads }))).toBe('done');
            expect(turnOf(mineTask({ turn: 'mine', open_threads }))).toBe('mine');
            expect(turnOf(mineTask({ turn: 'theirs', open_threads }))).toBe('theirs');
        }
    });

    test('turnOf falls back to mine only when the stored turn is missing or unknown', () => {
        expect(turnOf(mineTask({ turn: undefined, open_threads: 3 }))).toBe('mine');
        expect(turnOf(mineTask({ turn: 'nonsense', open_threads: 3 }))).toBe('mine');
    });
});

describe('open thread persistence and board rows', () => {
    test('PrTasks stores the latest open-thread count', () => {
        const tasks = new PrTasks(new Database(':memory:'));
        const task = tasks.upsert({
            repo: 'wego/payments-react-component',
            number: 458,
            url: 'https://github.com/wego/payments-react-component/pull/458',
            lane: 'mine',
        });

        expect(tasks.get(task.id).open_threads).toBeNull();
        tasks.setOpenThreads(task.id, 3);
        expect(tasks.get(task.id).open_threads).toBe(3);
        tasks.setOpenThreads(task.id, null);
        expect(tasks.get(task.id).open_threads).toBeNull();
    });

    test('renders the open count and keeps Merge available', () => {
        const row = buildPrBoardBlocks([
            mineTask({ open_threads: 3 }),
        ]).find(block => block.text?.text?.includes('#458'));

        expect(row.text.text).toContain('3 threads open');
        expect(row.text.text).toContain('approved');
        expect(row.accessory.action_id).toBe('pr_merge');
    });

    test('uses the singular thread label', () => {
        const text = JSON.stringify(buildPrBoardBlocks([
            mineTask({ open_threads: 1 }),
        ]));
        expect(text).toContain('1 thread open');
        expect(text).not.toContain('1 threads open');
    });

    test('zero renders byte-identically to a row without the new column', () => {
        expect(buildPrBoardBlocks([
            mineTask({ open_threads: 0 }),
        ])).toEqual(buildPrBoardBlocks([
            mineTask(),
        ]));
    });
});

describe('fetchReviewThreads', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('posts the GraphQL query and returns its review thread nodes', async () => {
        const nodes = [thread()];
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => graphqlBody(nodes),
        });

        await expect(fetchReviewThreads({
            repo: 'wego/payments-react-component',
            number: 458,
            token: 'token',
        })).resolves.toEqual(nodes);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.github.com/graphql',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token',
                    'Content-Type': 'application/json',
                }),
            })
        );
        const request = fetchMock.mock.calls[0][1];
        expect(JSON.parse(request.body).variables).toEqual({
            owner: 'wego',
            name: 'payments-react-component',
            number: 458,
        });
        expect(JSON.parse(request.body).query).toContain('reviewThreads(first:100)');
    });

    test('returns null and warns on a GraphQL errors payload', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ errors: [{ message: 'scope denied' }] }),
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(fetchReviewThreads({
            repo: 'wego/payments',
            number: 458,
            token: 'token',
        })).resolves.toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    test('returns null on non-200 and malformed responses', async () => {
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: { repository: null } }),
            });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const input = { repo: 'wego/payments', number: 458, token: 'token' };

        await expect(fetchReviewThreads(input)).resolves.toBeNull();
        await expect(fetchReviewThreads(input)).resolves.toBeNull();
        expect(warn).toHaveBeenCalledTimes(2);
    });

    test('warns instead of silently accepting a full first page', async () => {
        const nodes = Array.from({ length: 100 }, () => thread());
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => graphqlBody(nodes),
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(fetchReviewThreads({
            repo: 'wego/payments',
            number: 458,
            token: 'token',
        })).resolves.toHaveLength(100);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('100 review threads')
        );
    });
});
