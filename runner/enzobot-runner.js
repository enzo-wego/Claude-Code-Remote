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
const {
    buildReviewPrompt,
    buildApexReviewPrompt,
} = require('./prompts');

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
 * Line numbers in the new file that a PR's diff actually touches.
 *
 * GitHub only accepts an inline comment on a line inside a diff hunk, and it
 * rejects the ENTIRE review — not just the offending comment — when one is out
 * of range. So every anchor is checked against the real patch before posting.
 */
function commentableLines(patch) {
    const lines = new Set();
    let n = 0;
    for (const row of String(patch || '').split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) {
            n = Number(hunk[1]);
            continue;
        }
        if (row.startsWith('+') || row.startsWith(' ')) {
            lines.add(n);
            n += 1;
        }
        // '-' rows exist only on the left side; '\' is "no newline at EOF".
    }
    return lines;
}

/**
 * Split findings into those GitHub will accept inline and those it will not.
 * A finding is never dropped — an unanchorable one moves into the review body
 * with its location written out, which is exactly what the old single-comment
 * behaviour did for everything.
 */
function partitionComments(comments, filePatches) {
    const inline = [];
    const orphans = [];
    for (const c of Array.isArray(comments) ? comments : []) {
        const allowed = filePatches.get(c.path);
        const endOk = allowed && allowed.has(Number(c.line));
        const startOk = c.start_line === undefined
            || c.start_line === null
            || (allowed && allowed.has(Number(c.start_line)));
        if (!endOk || !startOk) {
            orphans.push(c);
            continue;
        }
        const entry = {
            path: c.path,
            line: Number(c.line),
            side: 'RIGHT',
            body: String(c.body || ''),
        };
        if (c.start_line !== undefined && c.start_line !== null
            && Number(c.start_line) !== Number(c.line)) {
            entry.start_line = Number(c.start_line);
            entry.start_side = 'RIGHT';
        }
        inline.push(entry);
    }
    return { inline, orphans };
}

function orphanSection(orphans) {
    if (!orphans.length) return '';
    const rows = orphans.map(c => {
        const at = c.start_line && Number(c.start_line) !== Number(c.line)
            ? `${c.path}:${c.start_line}-${c.line}`
            : `${c.path}:${c.line}`;
        return `**\`${at}\`** — ${String(c.body || '').trim()}`;
    });
    return '\n\n## Not anchorable to the diff\n\n'
        + '_These are about code this PR did not change, so GitHub cannot take '
        + 'them inline._\n\n'
        + rows.join('\n\n');
}

/**
 * Read the machine-readable verdict the review skill writes. Fails closed:
 * a missing, empty or unexpected file yields 'comment', never 'approve'.
 */
function readVerdict(verdictPath) {
    try {
        const raw = fs.readFileSync(verdictPath, 'utf8').trim().toLowerCase();
        return raw === 'approve' ? 'approve' : 'comment';
    } catch {
        return 'comment';
    }
}

/**
 * Structured findings, if the review produced any. Unreadable or malformed
 * JSON degrades to null so the post falls back to a single review-level
 * comment rather than failing — a bad findings file must not lose the review.
 */
function readReviewJson(reviewPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
        if (!parsed || !Array.isArray(parsed.comments)) return null;
        return { body: String(parsed.body || ''), comments: parsed.comments };
    } catch {
        return null;
    }
}

/**
 * Tab label for a review pane. Every review shares the one `enzobot` workspace,
 * so the tab name is the only thing distinguishing them — and the Jira key is
 * how you recognise your own work. Falls back to the repo for PRs whose title
 * carries no key (`ci: …`, `docs(e2e): …`).
 */
function jobLabel(repo, pr, title) {
    const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(String(title || ''));
    return `${key ? key[1] : String(repo).split('/').pop()}-pr${pr}`;
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
        // Approving is a vote that counts toward someone's merge, so it happens
        // only on an explicit 'approve' from the caller — never by default.
        const approving = payload.method === 'approve';
        const url = `https://github.com/${payload.repo}/pull/${payload.pr}`;
        const structured = payload.review && Array.isArray(payload.review.comments)
            && payload.review.comments.length > 0;

        if (structured) {
            // One review carrying many line-anchored comments. `gh pr review`
            // cannot do this — it only ever posts a single review-level body.
            const filesJson = execFileSync('gh', [
                'api',
                '--paginate',
                `repos/${payload.repo}/pulls/${payload.pr}/files`,
            ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

            const patches = new Map();
            for (const file of JSON.parse(filesJson)) {
                patches.set(file.filename, commentableLines(file.patch));
            }
            const { inline, orphans } = partitionComments(
                payload.review.comments, patches
            );

            const reviewFile = path.join(
                path.dirname(bodyFile), 'review.json'
            );
            fs.writeFileSync(reviewFile, JSON.stringify({
                event: approving ? 'APPROVE' : 'COMMENT',
                body: (payload.review.body || payload.body_md || '')
                    + orphanSection(orphans),
                comments: inline,
            }));

            execFileSync('gh', [
                'api',
                '--method', 'POST',
                `repos/${payload.repo}/pulls/${payload.pr}/reviews`,
                '--input', reviewFile,
            ], { encoding: 'utf8', timeout: 60_000 });

            return {
                posted: true,
                approved: approving,
                inline_comments: inline.length,
                body_only: orphans.length,
                review_url: url,
            };
        }

        fs.writeFileSync(bodyFile, payload.body_md || '');
        execFileSync('gh', [
            'pr',
            'review',
            String(payload.pr),
            '--repo',
            payload.repo,
            approving ? '--approve' : '--comment',
            '--body-file',
            bodyFile,
        ], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        return {
            posted: true,
            approved: approving,
            inline_comments: 0,
            review_url: url,
        };
    }

    if (job.kind === 'merge_pr') {
        // gh prompts for a strategy when none is given, which would hang a
        // non-interactive run — so always pass one.
        const method = { merge: '--merge', rebase: '--rebase' }[payload.method]
            || '--squash';
        execFileSync('gh', [
            'pr',
            'merge',
            String(payload.pr),
            '--repo',
            payload.repo,
            method,
        ], {
            encoding: 'utf8',
            timeout: 120_000,
        });
        return {
            merged: true,
            method: method.replace('--', ''),
            url: `https://github.com/${payload.repo}/pull/${payload.pr}`,
        };
    }

    if (job.kind === 'review' || job.kind === 'apex_review') {
        const directory = path.join(config.jobsDir, String(job.id));
        fs.mkdirSync(directory, { recursive: true });
        const resultPath = path.join(directory, 'result.md');
        const checkout = repoPath(config, payload.repo);

        const workspaceId = herdr.ensureWorkspace();
        const { paneId } = herdr.createJobPane(workspaceId, {
            label: jobLabel(payload.repo, payload.pr, payload.title),
            cwd: checkout,
        });
        herdr.startAgent(paneId, config.cliCommand);

        // The prompt goes to a file and only a one-line pointer is submitted:
        // herdr types multi-line text into the TUI without ever sending it.
        const promptPath = path.join(directory, 'prompt.md');
        fs.writeFileSync(promptPath, job.kind === 'apex_review'
            ? buildApexReviewPrompt(payload, resultPath)
            : buildReviewPrompt(payload, resultPath, checkout));
        herdr.submitTask(
            paneId,
            `Read ${promptPath} and follow it exactly.`
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
            // Anything but a clean, explicit "approve" means comment. A missing
            // or garbled verdict file must never be read as approval.
            verdict: readVerdict(resultPath + '.verdict'),
            // Optional: line-anchored findings. Absent or unparseable means the
            // post falls back to one review-level comment, as before.
            review: readReviewJson(resultPath + '.review.json'),
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

module.exports = {
    executeJob,
    pollOnce,
    // Exported so the anchoring can be dry-run against a real PR diff before
    // anything is posted — GitHub rejects the whole review on a bad anchor.
    commentableLines,
    partitionComments,
};
