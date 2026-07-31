const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../../runner/pane-notify');

describe('pane-notify', () => {
    let directory;
    let configPath;
    let logPath;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notify-'));
        configPath = path.join(directory, '.enzobot-runner.json');
        logPath = path.join(directory, 'pane-notify.log');
        fs.writeFileSync(configPath, JSON.stringify({
            vpsUrl: 'https://enzobot.example',
            token: 'runner-secret',
        }));
    });

    test('exits zero without reading config or posting outside an EnzoBot job pane', async () => {
        const fetchImpl = jest.fn();

        const code = await run({
            env: {},
            input: '{not json',
            fetchImpl,
            configPath: path.join(directory, 'missing.json'),
            logPath,
        });

        expect(code).toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(fs.existsSync(logPath)).toBe(false);
    });

    test('posts the stopped session message for the current job', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

        const code = await run({
            env: { ENZOBOT_JOB_ID: '42' },
            input: JSON.stringify({
                last_assistant_message: 'Say the word and I will write reply.md.',
                transcript_path: '/tmp/session.jsonl',
                session_id: 'session-1',
            }),
            fetchImpl,
            configPath,
            logPath,
        });

        expect(code).toBe(0);
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://enzobot.example/pane-event',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-runner-token': 'runner-secret',
                },
                body: JSON.stringify({
                    job_id: '42',
                    text: 'Say the word and I will write reply.md.',
                    kind: 'stop',
                }),
            }
        );
        expect(fs.existsSync(logPath)).toBe(false);
    });

    test('logs a failed post and still exits zero', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('VPS offline'));

        const code = await run({
            env: { ENZOBOT_JOB_ID: '42' },
            input: JSON.stringify({ last_assistant_message: 'Waiting on you.' }),
            fetchImpl,
            configPath,
            logPath,
        });

        expect(code).toBe(0);
        expect(fs.readFileSync(logPath, 'utf8')).toContain('VPS offline');
    });
});
