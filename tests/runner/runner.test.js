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
    });
});
