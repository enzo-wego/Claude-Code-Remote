#!/usr/bin/env node
/**
 * EnzoBot Mac runner — polls the VPS queue, executes jobs in herdr panes,
 * reports results. Dependency-free (Node stdlib + global fetch) so it runs
 * from a bare checkout under launchd.
 *
 * Config: ~/.enzobot-runner.json
 *   { "vpsUrl": "https://vps:9999", "token": "...",
 *     "repoRoot": "~/go/src/github.com",
 *     "repoMap": { "wego/payments": "~/go/src/github.com/payments" },
 *     "pollMs": 10000, "cliCommand": "claude",
 *     "jobTimeoutMs": 1500000 }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const herdrDefault = require('./herdr-exec');
const { buildReviewPrompt } = require('./prompts');

function loadConfig() {
    const configPath = path.join(os.homedir(), '.enzobot-runner.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const expand = value => value && value.replace(/^~/, os.homedir());
    config.repoRoot = expand(config.repoRoot);
    for (const repo of Object.keys(config.repoMap || {})) {
        config.repoMap[repo] = expand(config.repoMap[repo]);
    }
    config.jobsDir = expand(config.jobsDir || '~/enzobot-jobs');
    config.pollMs = config.pollMs || 10_000;
    config.cliCommand = config.cliCommand || 'claude';
    config.jobTimeoutMs = config.jobTimeoutMs || 25 * 60_000;
    return config;
}

function repoPath(config, repo) {
    if (config.repoMap && config.repoMap[repo]) {
        return config.repoMap[repo];
    }
    const guess = path.join(config.repoRoot, repo.split('/')[1]);
    if (fs.existsSync(guess)) return guess;
    throw new Error(`no local checkout for ${repo} (add it to repoMap)`);
}

/**
 * Execute one leased job. The herdr adapter and execFileSync are injectable
 * so routing remains unit-testable without touching a live workspace.
 */
async function executeJob(
    job,
    config,
    herdr,
    { execFileSync = childProcess.execFileSync } = {}
) {
    const payload = JSON.parse(job.payload_json);

    if (job.kind === 'post_review') {
        const bodyFile = path.join(
            config.jobsDir,
            String(job.id),
            'post-body.md'
        );
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, payload.body_md || '');
        execFileSync('gh', [
            'pr',
            'review',
            String(payload.pr),
            '--repo',
            payload.repo,
            '--comment',
            '--body-file',
            bodyFile,
        ], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        return { posted: true };
    }

    if (job.kind === 'review') {
        const directory = path.join(config.jobsDir, String(job.id));
        fs.mkdirSync(directory, { recursive: true });
        const resultPath = path.join(directory, 'result.md');
        const checkout = repoPath(config, payload.repo);

        const workspaceId = herdr.ensureWorkspace();
        const { paneId } = herdr.createJobPane(workspaceId, {
            label: `review-${payload.pr}`,
            cwd: checkout,
        });
        herdr.startAgent(paneId, config.cliCommand);
        herdr.submitTask(
            paneId,
            buildReviewPrompt(payload, resultPath, checkout)
        );
        herdr.waitDone(paneId, config.jobTimeoutMs);

        if (!fs.existsSync(resultPath)) {
            const tail = String(herdr.readTail(paneId, 60)).slice(-1500);
            throw new Error(`result.md missing; pane tail: ${tail}`);
        }
        return {
            body_md: fs.readFileSync(resultPath, 'utf8'),
            summary: fs.existsSync(resultPath + '.summary')
                ? fs.readFileSync(resultPath + '.summary', 'utf8').trim()
                : 'review ready',
            pane_id: paneId,
        };
    }

    throw new Error(`unknown job kind ${job.kind}`);
}

async function pollOnce(config, herdr) {
    const api = (route, body) => fetch(config.vpsUrl + route, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-runner-token': config.token,
        },
        body: JSON.stringify(body),
    }).then(response => response.json());

    const { job } = await api('/runner/lease', { target: 'mac' });
    if (!job) return false;
    console.log(`[runner] leased job ${job.id} (${job.kind})`);
    try {
        const result = await executeJob(job, config, herdr);
        await api('/runner/complete', {
            job_id: job.id,
            lease_id: job.lease_id,
            result,
        });
        console.log(`[runner] job ${job.id} done`);
    } catch (err) {
        console.error(`[runner] job ${job.id} failed: ${err.message}`);
        await api('/runner/fail', {
            job_id: job.id,
            lease_id: job.lease_id,
            error: err.message,
        });
    }
    return true;
}

async function main() {
    const config = loadConfig();
    console.log(
        `[runner] polling ${config.vpsUrl} every ${config.pollMs}ms`
    );
    for (;;) {
        try {
            await pollOnce(config, herdrDefault);
        } catch (err) {
            console.error(`[runner] poll error: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, config.pollMs));
    }
}

if (require.main === module) main();

module.exports = { executeJob, pollOnce };
