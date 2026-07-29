const { executeJob } = require('../../runner/enzobot-runner');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paneStub = (overrides = {}) => ({
    ensureWorkspace: jest.fn().mockReturnValue('wN'),
    createJobPane: jest.fn().mockReturnValue({ paneId: 'wN:p2' }),
    startAgent: jest.fn(),
    submitTask: jest.fn(),
    waitDone: jest.fn(),
    readTail: jest.fn().mockReturnValue(''),
    closePane: jest.fn(),
    paneStatus: jest.fn().mockReturnValue('idle'),
    ...overrides,
});

describe('executeJob', () => {
    test('review job: spawns pane, waits, reads result files', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const herdr = paneStub({
            waitDone: jest.fn(() => {
                fs.writeFileSync(path.join(jobsDir, '5', 'result.md'), '## Review\nLGTM');
                fs.writeFileSync(path.join(jobsDir, '5', 'result.md.summary'), '0 blocking');
            }),
        });
        const result = await executeJob(
            {
                id: 5,
                kind: 'review',
                payload_json: JSON.stringify({ repo: 'wego/payments', pr: 412 }),
            },
            { jobsDir, repoRoot: '/tmp', repoMap: { 'wego/payments': '/tmp/payments' }, cliCommand: 'claude' },
            herdr,
            { execFileSync: jest.fn() }
        );
        expect(result.body_md).toContain('LGTM');
        expect(result.summary).toBe('0 blocking');
        expect(herdr.submitTask).toHaveBeenCalled();
    });

    test('apex_review writes the prompt to a file and submits one line', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const herdr = paneStub({
            createJobPane: jest.fn().mockReturnValue({ paneId: 'wN:p9' }),
            waitDone: jest.fn(() => {
                fs.writeFileSync(path.join(jobsDir, '7', 'result.md'), 'Verdict: changes requested');
                fs.writeFileSync(path.join(jobsDir, '7', 'result.md.summary'), '1 blocking');
            }),
        });

        const result = await executeJob(
            {
                id: 7,
                kind: 'apex_review',
                payload_json: JSON.stringify({
                    repo: 'wego/payments', pr: 413,
                    url: 'https://github.com/wego/payments/pull/413',
                }),
            },
            { jobsDir, repoRoot: '/tmp', repoMap: { 'wego/payments': '/tmp/payments' }, cliCommand: 'claude' },
            herdr
        );

        expect(result.summary).toBe('1 blocking');
        // The pane the reviewer is left sitting in — Post talks to it later.
        expect(result.pane_id).toBe('wN:p9');

        // Submitted text must be ONE line: herdr types multi-line text into the
        // TUI without ever submitting it.
        const submitted = herdr.submitTask.mock.calls[0][1];
        expect(submitted).not.toContain('\n');
        expect(submitted).toContain(path.join(jobsDir, '7', 'prompt.md'));

        const written = fs.readFileSync(path.join(jobsDir, '7', 'prompt.md'), 'utf8');
        expect(written).toContain('/apex-review');
        expect(written).toContain('wego/payments#413');
        // It must stay resident so a later Post has something to talk to.
        expect(written).toMatch(/Stay in this\s+session/i);
    });

    test('merge_pr always passes a strategy so gh cannot prompt', async () => {
        const gh = jest.fn().mockReturnValue('');
        const result = await executeJob(
            {
                id: 8,
                kind: 'merge_pr',
                payload_json: JSON.stringify({ repo: 'wego/payments', pr: 412 }),
            },
            { jobsDir: os.tmpdir(), repoMap: {} },
            paneStub(),
            { execFileSync: gh }
        );
        expect(gh.mock.calls[0][1]).toEqual(expect.arrayContaining(['pr', 'merge', '--squash']));
        expect(result.merged).toBe(true);
    });
});

/**
 * Post/Edit are relayed to the reviewer that is still sitting in its pane. It
 * holds the worktree, the diff and its own findings, so it places its own
 * inline comments — no diff fetching or anchor validation on this side.
 */
describe('pane_message', () => {
    const jobFor = (text) => ({
        id: 30,
        kind: 'pane_message',
        payload_json: JSON.stringify({ pane_id: 'wN:p2', repo: 'wego/payments', pr: 2210, text }),
    });

    test('delivers a short instruction verbatim and reports the tail', async () => {
        const herdr = paneStub({ readTail: jest.fn().mockReturnValue('Posted review.') });
        const result = await executeJob(
            jobFor('Post the review to GitHub now as a COMMENT.'),
            { jobsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')), jobTimeoutMs: 1000 },
            herdr
        );
        expect(herdr.submitTask).toHaveBeenCalledWith(
            'wN:p2', 'Post the review to GitHub now as a COMMENT.'
        );
        expect(result.delivered).toBe(true);
        expect(result.tail).toContain('Posted review.');
    });

    test('a multi-line instruction goes to a file, not into the TUI', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
        const herdr = paneStub();
        await executeJob(
            jobFor('drop the nit\nkeep suggestion 3\n\nthen post it'),
            { jobsDir, jobTimeoutMs: 1000 },
            herdr
        );
        const submitted = herdr.submitTask.mock.calls[0][1];
        expect(submitted).not.toContain('\n');
        expect(fs.readFileSync(path.join(jobsDir, '30', 'message.md'), 'utf8'))
            .toContain('keep suggestion 3');
    });

    test('a closed session fails with something actionable', async () => {
        await expect(executeJob(
            jobFor('post it'),
            { jobsDir: os.tmpdir(), jobTimeoutMs: 1000 },
            paneStub({ paneStatus: jest.fn().mockReturnValue('gone') })
        )).rejects.toThrow(/gone — re-run the review/);
    });
});

describe('pane_close', () => {
    test('closes the session and touches nothing else', async () => {
        const herdr = paneStub();
        const gh = jest.fn();
        const result = await executeJob(
            {
                id: 31,
                kind: 'pane_close',
                payload_json: JSON.stringify({ pane_id: 'wN:p2', repo: 'wego/payments', pr: 2210 }),
            },
            { jobsDir: os.tmpdir() },
            herdr,
            { execFileSync: gh }
        );
        expect(herdr.closePane).toHaveBeenCalledWith('wN:p2');
        expect(gh).not.toHaveBeenCalled();
        expect(result.closed).toBe(true);
    });
});

describe('herdr submitTask guards', () => {
    const { submitTask } = require('../../runner/herdr-exec');

    test('refuses a multi-line prompt instead of typing it and hanging', () => {
        expect(() => submitTask('w9:p2', 'line one\nline two')).toThrow(/single-line/);
    });
});

describe('tab naming', () => {
    let jobsDir;
    beforeEach(() => {
        jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));
    });

    const run = async (payload) => {
        const herdr = paneStub({
            waitDone: jest.fn(() => {
                fs.writeFileSync(path.join(jobsDir, '9', 'result.md'), 'ok');
            }),
        });
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
        expect(await run({ repo: 'wego/wego-docs', pr: 793 })).toBe('wego-docs-pr793');
    });
});
