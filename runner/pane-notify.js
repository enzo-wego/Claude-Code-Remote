#!/usr/bin/env node
/**
 * Claude Stop hook for EnzoBot Mac-runner panes.
 *
 * Ordinary Claude sessions do not have ENZOBOT_JOB_ID and return before
 * reading stdin or runner config. Notification failures are logged locally
 * and never fail the Claude turn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.enzobot-runner.json');
const DEFAULT_LOG_PATH = path.join(__dirname, 'pane-notify.log');

async function readInput(input) {
    if (typeof input === 'string') return input;
    let text = '';
    for await (const chunk of input) text += chunk;
    return text;
}

function logFailure(logPath, error) {
    try {
        const message = error && error.message ? error.message : String(error);
        fs.appendFileSync(
            logPath,
            `${new Date().toISOString()} ${message}\n`
        );
    } catch {
        // A broken notification log must not break the owner's Claude session.
    }
}

async function run({
    env = process.env,
    input = process.stdin,
    fetchImpl = global.fetch,
    configPath = DEFAULT_CONFIG_PATH,
    logPath = DEFAULT_LOG_PATH,
} = {}) {
    const jobId = env.ENZOBOT_JOB_ID;
    if (!jobId) return 0;

    try {
        const raw = await readInput(input);
        const payload = raw.trim() ? JSON.parse(raw) : {};
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const url = String(config.vpsUrl || '').replace(/\/+$/, '');
        const response = await fetchImpl(`${url}/pane-event`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-runner-token': config.token,
            },
            body: JSON.stringify({
                job_id: String(jobId),
                text: String(payload.last_assistant_message || ''),
                kind: 'stop',
            }),
        });
        if (!response.ok) {
            throw new Error(`pane-event returned HTTP ${response.status}`);
        }
    } catch (error) {
        logFailure(logPath, error);
    }
    return 0;
}

if (require.main === module) {
    run().then(
        code => { process.exitCode = code; },
        error => {
            logFailure(DEFAULT_LOG_PATH, error);
            process.exitCode = 0;
        }
    );
}

module.exports = { run };
