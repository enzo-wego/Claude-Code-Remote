const { executeJob } = require('../../runner/enzobot-runner');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('executeJob', () => {
    test('review job: spawns pane, waits, reads result files', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const job = {
            id: 5,
            kind: 'review',
            payload_json: JSON.stringify({
                repo: 'wego/payments',
                pr: 412,
            }),
        };
        const herdr = {
            ensureWorkspace: jest.fn().mockReturnValue('w9'),
            createJobPane: jest.fn().mockReturnValue({ paneId: 'w9:p1' }),
            startAgent: jest.fn(),
            submitTask: jest.fn(),
            waitDone: jest.fn(() => {
                fs.writeFileSync(
                    path.join(jobsDir, '5', 'result.md'),
                    '## Review\nLGTM'
                );
                fs.writeFileSync(
                    path.join(jobsDir, '5', 'result.md.summary'),
                    '0 blocking'
                );
            }),
            readTail: jest.fn().mockReturnValue('RESULT_READY'),
        };
        const config = {
            jobsDir,
            repoRoot: '/tmp',
            repoMap: { 'wego/payments': '/tmp/payments' },
            cliCommand: 'claude',
        };
        const result = await executeJob(job, config, herdr, {
            execFileSync: jest.fn(),
        });
        expect(result.body_md).toContain('LGTM');
        expect(result.summary).toBe('0 blocking');
        expect(herdr.submitTask).toHaveBeenCalled();
    });

    test('post_review job: calls gh with body file, no pane', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const gh = jest.fn().mockReturnValue('');
        const job = {
            id: 6,
            kind: 'post_review',
            payload_json: JSON.stringify({
                repo: 'wego/payments',
                pr: 412,
                body_md: 'REVIEW',
            }),
        };
        const result = await executeJob(
            job,
            { jobsDir, repoMap: {} },
            {},
            { execFileSync: gh }
        );
        expect(gh).toHaveBeenCalledWith(
            'gh',
            expect.arrayContaining([
                'pr',
                'review',
                '412',
                '--repo',
                'wego/payments',
                '--comment',
            ]),
            expect.anything()
        );
        expect(result.posted).toBe(true);
        expect(result.review_url).toBe(
            'https://github.com/wego/payments/pull/412'
        );
    });

    test('apex_review job runs apex-review in a pane and reads the draft', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const job = {
            id: 7,
            kind: 'apex_review',
            payload_json: JSON.stringify({
                repo: 'wego/payments',
                pr: 413,
                url: 'https://github.com/wego/payments/pull/413',
            }),
        };
        const herdr = {
            ensureWorkspace: jest.fn().mockReturnValue('w9'),
            createJobPane: jest.fn().mockReturnValue({ paneId: 'w9:p2' }),
            startAgent: jest.fn(),
            submitTask: jest.fn(),
            waitDone: jest.fn(() => {
                fs.writeFileSync(
                    path.join(jobsDir, '7', 'result.md'),
                    'Verdict: changes requested'
                );
                fs.writeFileSync(
                    path.join(jobsDir, '7', 'result.md.summary'),
                    '1 blocking'
                );
            }),
            readTail: jest.fn().mockReturnValue('RESULT_READY'),
        };

        const result = await executeJob(job, {
            jobsDir,
            repoRoot: '/tmp',
            repoMap: { 'wego/payments': '/tmp/payments' },
            cliCommand: 'claude',
        }, herdr);

        expect(result.summary).toBe('1 blocking');

        // The submitted text must be ONE line: herdr types multi-line text into
        // the TUI without ever submitting it, which parked the pane at idle and
        // burned all three attempts opening a fresh pane each time.
        const submitted = herdr.submitTask.mock.calls[0][1];
        expect(submitted).not.toContain('\n');
        expect(submitted).toContain(path.join(jobsDir, '7', 'prompt.md'));

        // The real instructions live in the file the pointer names.
        const written = fs.readFileSync(
            path.join(jobsDir, '7', 'prompt.md'),
            'utf8'
        );
        expect(written).toContain('/apex-review');
        expect(written).toContain('wego/payments#413');
    });
});

describe('herdr submitTask guards', () => {
    const { submitTask } = require('../../runner/herdr-exec');

    test('refuses a multi-line prompt instead of typing it and hanging', () => {
        expect(() => submitTask('w9:p2', 'line one\nline two'))
            .toThrow(/single-line/);
    });
});

describe('tab naming', () => {
    let jobsDir;
    beforeEach(() => {
        jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));
    });

    const run = async (payload) => {
        const herdr = {
            ensureWorkspace: jest.fn().mockReturnValue('wN'),
            createJobPane: jest.fn().mockReturnValue({ paneId: 'wN:p2' }),
            startAgent: jest.fn(),
            submitTask: jest.fn(),
            waitDone: jest.fn(() => {
                const dir = path.join(jobsDir, '9');
                fs.writeFileSync(path.join(dir, 'result.md'), 'ok');
            }),
            readTail: jest.fn().mockReturnValue(''),
        };
        await executeJob(
            { id: 9, kind: 'apex_review', payload_json: JSON.stringify(payload) },
            { jobsDir, repoRoot: '/tmp', repoMap: { [payload.repo]: '/tmp' }, cliCommand: 'claude' },
            herdr
        );
        return herdr.createJobPane.mock.calls[0][1].label;
    };

    test('uses the Jira key from the PR title', async () => {
        expect(await run({
            repo: 'wego/payments', pr: 2210,
            title: 'PAY-2225: add webhook/checkout/cron observability counters',
        })).toBe('PAY-2225-pr2210');
    });

    test('falls back to the repo when the title carries no key', async () => {
        expect(await run({
            repo: 'wego/payments-knowledge', pr: 6,
            title: 'apex-review: use fresh refs for cross-repo checks',
        })).toBe('payments-knowledge-pr6');
    });

    test('survives a payload with no title at all', async () => {
        expect(await run({ repo: 'wego/wego-docs', pr: 793 }))
            .toBe('wego-docs-pr793');
    });
});

describe('approve vs comment', () => {
    const ghArgsFor = async (method) => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-'));
        const gh = jest.fn().mockReturnValue('');
        const result = await executeJob(
            {
                id: 11,
                kind: 'post_review',
                payload_json: JSON.stringify({
                    repo: 'wego/payments', pr: 2210, body_md: 'LGTM', method,
                }),
            },
            { jobsDir, repoMap: {} },
            {},
            { execFileSync: gh }
        );
        return { args: gh.mock.calls[0][1], result };
    };

    test('method=approve files a GitHub approval', async () => {
        const { args, result } = await ghArgsFor('approve');
        expect(args).toContain('--approve');
        expect(args).not.toContain('--comment');
        expect(result.approved).toBe(true);
    });

    test('anything else stays a comment', async () => {
        for (const method of ['comment', undefined, 'APPROVE ', 'yes']) {
            const { args, result } = await ghArgsFor(method);
            expect(args).toContain('--comment');
            expect(args).not.toContain('--approve');
            expect(result.approved).toBe(false);
        }
    });

    /** A missing or garbled verdict file must never read as approval. */
    test('verdict file is read strictly', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
        const cases = [
            ['approve\n', 'approve'],
            ['APPROVE', 'approve'],
            ['comment', 'comment'],
            ['approve, with suggestions', 'comment'],
            ['', 'comment'],
            [null, 'comment'],
        ];

        for (const [written, expected] of cases) {
            const dir = path.join(jobsDir, '12');
            const herdr = {
                ensureWorkspace: jest.fn().mockReturnValue('wN'),
                createJobPane: jest.fn().mockReturnValue({ paneId: 'wN:p3' }),
                startAgent: jest.fn(),
                submitTask: jest.fn(),
                waitDone: jest.fn(() => {
                    fs.writeFileSync(path.join(dir, 'result.md'), 'body');
                    if (written !== null) {
                        fs.writeFileSync(path.join(dir, 'result.md.verdict'), written);
                    }
                }),
                readTail: jest.fn().mockReturnValue(''),
            };
            fs.rmSync(dir, { recursive: true, force: true });
            const out = await executeJob(
                {
                    id: 12,
                    kind: 'apex_review',
                    payload_json: JSON.stringify({ repo: 'wego/payments', pr: 1 }),
                },
                { jobsDir, repoRoot: '/tmp', repoMap: { 'wego/payments': '/tmp' }, cliCommand: 'claude' },
                herdr
            );
            expect(out.verdict).toBe(expected);
        }
    });
});

describe('inline review comments', () => {
    // A real patch: hunk starts at new-file line 106, so 106..110 are
    // commentable and anything outside is not.
    const PATCH = [
        '@@ -100,4 +106,5 @@ func handle() {',
        ' 	ctx := r.Context()',
        '+	defer recoverPanic(ctx)',
        ' 	if err != nil {',
        '-		log.Print(err)',
        '+		log.Error(ctx, err)',
        ' 	}',
    ].join('\n');

    const post = async (comments, method = 'comment') => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-'));
        const calls = [];
        const gh = jest.fn((bin, args) => {
            calls.push(args);
            if (args[0] === 'api' && args.includes('--paginate')) {
                return JSON.stringify([
                    { filename: 'pkg/http/rest/automation_handlers.go', patch: PATCH },
                ]);
            }
            return '';
        });
        const result = await executeJob(
            {
                id: 21,
                kind: 'post_review',
                payload_json: JSON.stringify({
                    repo: 'wego/payments', pr: 2210, method,
                    body_md: 'fallback body',
                    review: { body: '**LGTM**', comments },
                }),
            },
            { jobsDir, repoMap: {} },
            {},
            { execFileSync: gh }
        );
        const postCall = calls.find(a => a.includes('--method'));
        const sent = JSON.parse(fs.readFileSync(
            path.join(jobsDir, '21', 'review.json'), 'utf8'
        ));
        return { result, postCall, sent };
    };

    test('anchors findings on lines the diff touches', async () => {
        const { result, postCall, sent } = await post([
            { path: 'pkg/http/rest/automation_handlers.go', line: 107, body: 'panic swallowed' },
            { path: 'pkg/http/rest/automation_handlers.go', line: 110, start_line: 108, body: 'range finding' },
        ]);

        expect(postCall).toContain('repos/wego/payments/pulls/2210/reviews');
        expect(sent.event).toBe('COMMENT');
        expect(sent.comments).toHaveLength(2);
        expect(sent.comments[0]).toEqual(expect.objectContaining({
            path: 'pkg/http/rest/automation_handlers.go', line: 107, side: 'RIGHT',
        }));
        expect(sent.comments[1]).toEqual(expect.objectContaining({
            start_line: 108, start_side: 'RIGHT', line: 110,
        }));
        expect(result.inline_comments).toBe(2);
        expect(result.body_only).toBe(0);
    });

    /** The whole review 422s if one anchor is out of range, so they move. */
    test('findings outside the diff move into the body, never dropped', async () => {
        const { result, sent } = await post([
            { path: 'pkg/http/rest/automation_handlers.go', line: 107, body: 'in range' },
            { path: 'pkg/http/rest/automation_handlers.go', line: 900, body: 'untouched code' },
            { path: 'pkg/other/never_in_diff.go', line: 12, body: 'file not in PR' },
        ]);

        expect(sent.comments).toHaveLength(1);
        expect(result.inline_comments).toBe(1);
        expect(result.body_only).toBe(2);
        expect(sent.body).toContain('Not anchorable');
        expect(sent.body).toContain('automation_handlers.go:900');
        expect(sent.body).toContain('untouched code');
        expect(sent.body).toContain('never_in_diff.go:12');
    });

    test('approving carries the inline comments in the same review', async () => {
        const { sent, result } = await post(
            [{ path: 'pkg/http/rest/automation_handlers.go', line: 108, body: 'nit' }],
            'approve'
        );
        expect(sent.event).toBe('APPROVE');
        expect(sent.comments).toHaveLength(1);
        expect(result.approved).toBe(true);
    });

    test('no structured findings falls back to one review-level comment', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'));
        const gh = jest.fn().mockReturnValue('');
        const result = await executeJob(
            {
                id: 22,
                kind: 'post_review',
                payload_json: JSON.stringify({
                    repo: 'wego/payments', pr: 2210,
                    body_md: 'plain review', review: null,
                }),
            },
            { jobsDir, repoMap: {} },
            {},
            { execFileSync: gh }
        );
        expect(gh.mock.calls[0][1]).toEqual(expect.arrayContaining(['pr', 'review', '--comment']));
        expect(result.inline_comments).toBe(0);
    });
});
