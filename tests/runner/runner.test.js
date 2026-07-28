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
