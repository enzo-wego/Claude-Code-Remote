# EnzoBot Plan D — Mac Execution Plane + Auto-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Heavy jobs (starting with PR review) execute on Enzo's Mac in watchable herdr panes, dispatched from the VPS through a sleep-proof job queue; results come back to Slack as drafts with one-tap Post/Discard.

**Architecture:** The VPS (stable network) holds a `jobs` table and three token-authenticated HTTP endpoints (`lease`/`complete`/`fail`). A dependency-free Node daemon on the Mac (launchd) polls outbound every ~10s, executes each job as a Claude Code TUI inside a dedicated `enzobot` herdr workspace (native `agent-status` completion detection — no output polling), and posts results back. Review results are DMed to the owner with buttons; "Post review" enqueues a second job that posts via the Mac's own `gh` auth — **no write credentials ever land on the VPS**.

**Tech Stack:** Node (existing repo for VPS side; runner uses only Node stdlib + global `fetch`), better-sqlite3, herdr CLI (Mac), `gh` CLI (Mac), launchd, jest.

**Repository:** `Claude-Code-Remote` (this repo, Node.js) — VPS endpoints + a new `runner/` directory for the Mac daemon. No other repo.

**Provider APIs:** **None in our code.** The queue and runner are plumbing. The review itself is Claude Code running in a herdr pane (Anthropic via Claude Code subscription auth, no API key). Do NOT add any LLM SDK call. (See `2026-07-28-enzobot-master-index.md` for the full provider matrix.)

**Relation to other plans:** Independent of Plan B code (shares only the SQLite file + Express app). Plan B's brief later gains "review arrived" items for free once both exist. The spec's v2 "Mac job-queue runner" is pulled forward by this plan.

---

## Design constraints (locked with owner)

- **Queue + Mac-polls** (outbound-only): lid closed → jobs wait; lid opens → drained in seconds. No Tailscale/SSH dependency, no ports exposed on the Mac.
- **Watchable execution:** jobs run as bare interactive `claude` TUIs in herdr panes (owner's standing rule: never headless `-p`/`exec` for CLI workers). Panes stay open after completion for inspection; the runner only closes panes it created, and only on the next job's cleanup pass.
- **Auto-review, graduated:** stage 1 (this plan) auto-*drafts* on review-request detection and DMs the draft; posting is a button tap. Stage 2 (later, per-repo whitelist) skips the tap.
- **Suggest-only boundary intact:** the only outward action is `gh pr review --comment`, and it fires exclusively from the owner's explicit button tap, using the owner's own Mac `gh` session.
- **Runner etiquette:** the runner discovers or creates a workspace labeled `enzobot` and never targets any pane/tab/workspace outside it. All IDs come from herdr JSON responses, never constructed.

## Job lifecycle

```
pending ──lease(target=mac, TTL 30m)──▶ leased ──complete──▶ done
   ▲                                      │
   └────────── lease expired ◀────────────┘─fail(attempts<3 → pending, else failed)
```

Job row: `{id, dedupe_key?, kind: 'review'|'post_review', target: 'mac', payload_json, status, lease_id, leased_at, attempts, result_json, error, created_at, updated_at}`

`review` payload: `{repo: 'wego/payments', pr: 412, url, requested_by}` → result: `{summary, body_md}`
`post_review` payload: `{repo, pr, body_md}` → result: `{posted: true, review_url}`

## File structure

| File | Responsibility |
|---|---|
| `src/services/jobs.js` (new) | Jobs table + atomic lease/complete/fail semantics |
| `scripts/jobs-cli.js` (new) | enqueue/list/show for the companion + humans |
| `src/channels/slack/job-results.js` (new) | Result → owner DM (blocks + buttons), button handlers |
| `src/channels/slack/socket.js` (modify) | `/runner/*` + `/jobs` endpoints, button registration, review-request auto-enqueue sweep |
| `runner/enzobot-runner.js` (new) | Mac daemon: poll → execute → report (stdlib only) |
| `runner/herdr-exec.js` (new) | herdr workspace/pane lifecycle + agent-status waits |
| `runner/prompts.js` (new) | Review prompt builder (worktree-isolated, file-based result) |
| `runner/com.enzo.enzobot-runner.plist` (new) | launchd template |
| `runner/README.md` (new) | Mac install steps |
| `.env.example` (modify) | `RUNNER_TOKEN`, `AUTO_REVIEW_ENABLED`, `AUTO_REVIEW_INTERVAL_MIN` |

---

### Task 1: Jobs store with lease semantics

**Files:**
- Create: `src/services/jobs.js`
- Test: `tests/services/jobs.test.js`
- Modify: `src/channels/slack/socket.js` (`_initDb`, after the `this.agenda = new Agenda(this.db)` line added by Plan B — if Plan B is not yet merged, place after the "Cleaned up expired sessions" block ~line 386)

- [ ] **Step 1: Write the failing test**

```js
// tests/services/jobs.test.js
const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');

const create = () => new Jobs(new Database(':memory:'));

describe('Jobs', () => {
    test('enqueue then lease claims oldest pending and returns payload', () => {
        const jobs = create();
        jobs.enqueue('review', { repo: 'wego/payments', pr: 412 }, { dedupeKey: 'review:wego/payments#412' });
        const leased = jobs.lease('mac');
        expect(leased.kind).toBe('review');
        expect(JSON.parse(leased.payload_json).pr).toBe(412);
        expect(leased.lease_id).toBeTruthy();
        expect(jobs.lease('mac')).toBeNull(); // nothing else pending
    });

    test('dedupe_key blocks duplicate live jobs but allows re-enqueue after done', () => {
        const jobs = create();
        const a = jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' });
        expect(jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' })).toBeNull();
        const leased = jobs.lease('mac');
        jobs.complete(leased.id, leased.lease_id, { ok: true });
        expect(jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' })).not.toBeNull();
        expect(a.id).toBeTruthy();
    });

    test('complete with wrong lease_id is rejected', () => {
        const jobs = create();
        jobs.enqueue('review', { pr: 2 });
        const leased = jobs.lease('mac');
        expect(jobs.complete(leased.id, 'wrong-lease', { ok: true })).toBe(false);
        expect(jobs.get(leased.id).status).toBe('leased');
    });

    test('expired lease is re-claimable; attempts increment; 3rd fail is terminal', () => {
        const jobs = create();
        jobs.enqueue('review', { pr: 3 });
        const l1 = jobs.lease('mac', { ttlMs: -1 }); // instantly expired
        const l2 = jobs.lease('mac');                 // re-claims the same row
        expect(l2.id).toBe(l1.id);
        expect(l2.attempts).toBe(2);
        jobs.fail(l2.id, l2.lease_id, 'boom');        // attempts 2 → pending again
        const l3 = jobs.lease('mac');
        jobs.fail(l3.id, l3.lease_id, 'boom again');  // attempts 3 → failed
        expect(jobs.get(l3.id).status).toBe('failed');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/jobs.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/services/jobs.js`**

```js
/**
 * Jobs — sleep-proof VPS→Mac work queue. The Mac runner polls /runner/lease;
 * a lease is a soft lock (lease_id + TTL): if the Mac dies mid-job the row
 * becomes claimable again and attempts increments. 3 attempts → failed.
 */
const crypto = require('crypto');
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

class Jobs {
    constructor(db) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key   TEXT,
                kind         TEXT NOT NULL,
                target       TEXT NOT NULL DEFAULT 'mac',
                payload_json TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                lease_id     TEXT,
                leased_at    INTEGER,
                lease_ttl_ms INTEGER,
                attempts     INTEGER NOT NULL DEFAULT 0,
                result_json  TEXT,
                error        TEXT,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            )
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, target)');
        this._s = {
            liveByKey: db.prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('pending','leased')"),
            insert: db.prepare(`INSERT INTO jobs (dedupe_key, kind, target, payload_json, created_at, updated_at)
                                VALUES (@dedupe_key, @kind, @target, @payload_json, @now, @now)`),
            claimable: db.prepare(`
                SELECT * FROM jobs WHERE target = ? AND (
                    status = 'pending' OR
                    (status = 'leased' AND leased_at + lease_ttl_ms < ?)
                ) ORDER BY created_at ASC LIMIT 1`),
            claim: db.prepare(`
                UPDATE jobs SET status='leased', lease_id=@lease_id, leased_at=@now,
                    lease_ttl_ms=@ttl, attempts=attempts+1, updated_at=@now
                WHERE id=@id AND (status='pending' OR (status='leased' AND leased_at + lease_ttl_ms < @now))`),
            complete: db.prepare(`UPDATE jobs SET status='done', result_json=@result, updated_at=@now
                                  WHERE id=@id AND lease_id=@lease_id AND status='leased'`),
            failTerminal: db.prepare(`UPDATE jobs SET status='failed', error=@error, updated_at=@now
                                      WHERE id=@id AND lease_id=@lease_id AND status='leased'`),
            failRetry: db.prepare(`UPDATE jobs SET status='pending', lease_id=NULL, error=@error, updated_at=@now
                                   WHERE id=@id AND lease_id=@lease_id AND status='leased'`),
            get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
            recent: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?'),
        };
    }

    enqueue(kind, payload, { target = 'mac', dedupeKey = null } = {}) {
        if (dedupeKey && this._s.liveByKey.get(dedupeKey)) return null;
        const info = this._s.insert.run({
            dedupe_key: dedupeKey, kind, target,
            payload_json: JSON.stringify(payload), now: Date.now(),
        });
        return this._s.get.get(info.lastInsertRowid);
    }

    lease(target, { ttlMs = DEFAULT_TTL_MS } = {}) {
        const row = this._s.claimable.get(target, Date.now());
        if (!row) return null;
        const lease_id = crypto.randomUUID();
        const res = this._s.claim.run({ id: row.id, lease_id, now: Date.now(), ttl: ttlMs });
        if (res.changes === 0) return null; // lost a race
        return this._s.get.get(row.id);
    }

    complete(id, leaseId, result) {
        return this._s.complete.run({ id, lease_id: leaseId, result: JSON.stringify(result), now: Date.now() }).changes > 0;
    }

    fail(id, leaseId, error) {
        const row = this._s.get.get(id);
        if (!row) return false;
        const stmt = row.attempts >= MAX_ATTEMPTS ? this._s.failTerminal : this._s.failRetry;
        return stmt.run({ id, lease_id: leaseId, error: String(error).slice(0, 2000), now: Date.now() }).changes > 0;
    }

    get(id) { return this._s.get.get(id); }
    recent(limit = 50) { return this._s.recent.all(limit); }
}

module.exports = Jobs;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/jobs.test.js -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into `_initDb` and commit**

In `src/channels/slack/socket.js` requires: `const Jobs = require('../../services/jobs');`
At the end of `_initDb()`: `this.jobs = new Jobs(this.db);`

```bash
npm test   # all green
git add src/services/jobs.js tests/services/jobs.test.js src/channels/slack/socket.js
git commit -m "Add jobs queue with lease semantics for Mac runner"
```

---

### Task 2: Runner HTTP endpoints on the VPS

**Files:**
- Modify: `src/channels/slack/socket.js` (HTTP section, next to `POST /daily-summary` ~line 6038)
- Test: `tests/channels/runner-endpoints.test.js`

- [ ] **Step 1: Write the failing test** (handlers factored to a pure-ish module so no Express spin-up is needed)

```js
// tests/channels/runner-endpoints.test.js
const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');
const { makeRunnerHandlers } = require('../../src/channels/slack/runner-endpoints');

function setup() {
    const jobs = new Jobs(new Database(':memory:'));
    const onResult = jest.fn().mockResolvedValue();
    const h = makeRunnerHandlers({ jobs, token: 'sekret', onResult });
    const res = () => {
        const r = { code: 200, body: null };
        r.status = (c) => { r.code = c; return r; };
        r.json = (b) => { r.body = b; return r; };
        return r;
    };
    return { jobs, h, res, onResult };
}

describe('runner endpoints', () => {
    test('rejects bad token', async () => {
        const { h, res } = setup();
        const r = res();
        await h.lease({ headers: { 'x-runner-token': 'nope' }, body: {} }, r);
        expect(r.code).toBe(401);
    });

    test('lease returns null when empty, then a job after enqueue', async () => {
        const { jobs, h, res } = setup();
        const r1 = res();
        await h.lease({ headers: { 'x-runner-token': 'sekret' }, body: { target: 'mac' } }, r1);
        expect(r1.body.job).toBeNull();
        jobs.enqueue('review', { pr: 7 });
        const r2 = res();
        await h.lease({ headers: { 'x-runner-token': 'sekret' }, body: { target: 'mac' } }, r2);
        expect(r2.body.job.kind).toBe('review');
    });

    test('complete stores result and fires onResult', async () => {
        const { jobs, h, res, onResult } = setup();
        jobs.enqueue('review', { pr: 8 });
        const leased = jobs.lease('mac');
        const r = res();
        await h.complete({ headers: { 'x-runner-token': 'sekret' },
            body: { job_id: leased.id, lease_id: leased.lease_id, result: { summary: 'ok' } } }, r);
        expect(r.body.ok).toBe(true);
        expect(jobs.get(leased.id).status).toBe('done');
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ id: leased.id }));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/channels/runner-endpoints.test.js -v`
Expected: FAIL — cannot find module `runner-endpoints`

- [ ] **Step 3: Implement `src/channels/slack/runner-endpoints.js`**

```js
/**
 * HTTP handlers the Mac runner calls. Auth: constant-time compare on
 * X-Runner-Token. onResult(jobRow) fires after a successful complete so
 * socket.js can DM the owner (job-results.js).
 */
const crypto = require('crypto');

function tokenOk(req, token) {
    const got = req.headers['x-runner-token'] || '';
    const a = Buffer.from(String(got)), b = Buffer.from(String(token));
    return token && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeRunnerHandlers({ jobs, token, onResult }) {
    return {
        async lease(req, res) {
            if (!tokenOk(req, token)) return res.status(401).json({ error: 'bad token' });
            const job = jobs.lease((req.body && req.body.target) || 'mac');
            return res.json({ job: job || null });
        },
        async complete(req, res) {
            if (!tokenOk(req, token)) return res.status(401).json({ error: 'bad token' });
            const { job_id, lease_id, result } = req.body || {};
            const ok = jobs.complete(job_id, lease_id, result || {});
            if (ok && onResult) await onResult(jobs.get(job_id));
            return res.json({ ok });
        },
        async fail(req, res) {
            if (!tokenOk(req, token)) return res.status(401).json({ error: 'bad token' });
            const { job_id, lease_id, error } = req.body || {};
            return res.json({ ok: jobs.fail(job_id, lease_id, error || 'unknown') });
        },
        async enqueue(req, res) {
            if (!tokenOk(req, token)) return res.status(401).json({ error: 'bad token' });
            const { kind, payload, dedupe_key, target } = req.body || {};
            if (!kind || !payload) return res.status(400).json({ error: 'kind and payload required' });
            const row = jobs.enqueue(kind, payload, { dedupeKey: dedupe_key || null, target: target || 'mac' });
            return res.json({ job: row, deduped: row === null });
        },
    };
}

module.exports = { makeRunnerHandlers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/channels/runner-endpoints.test.js -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Mount in socket.js**

Next to `POST /daily-summary` (~6038); mirror the surrounding route style and the Express app local name used there:

```js
        // Entity Plan D: Mac-runner queue endpoints (token-authed).
        const { makeRunnerHandlers } = require('./runner-endpoints');
        const runnerHandlers = makeRunnerHandlers({
            jobs: this.jobs,
            token: process.env.RUNNER_TOKEN || '',
            onResult: (job) => this._onJobResult(job), // Task 3
        });
        httpApp.post('/runner/lease', (req, res) => runnerHandlers.lease(req, res));
        httpApp.post('/runner/complete', (req, res) => runnerHandlers.complete(req, res));
        httpApp.post('/runner/fail', (req, res) => runnerHandlers.fail(req, res));
        httpApp.post('/jobs', (req, res) => runnerHandlers.enqueue(req, res));
```

Add a temporary stub until Task 3: `async _onJobResult(job) { this.logger.info(\`job ${job.id} done\`); }`

- [ ] **Step 6: Full suite + commit**

```bash
npm test
git add src/channels/slack/runner-endpoints.js src/channels/slack/socket.js tests/channels/runner-endpoints.test.js
git commit -m "Add token-authed runner lease/complete/fail/enqueue endpoints"
```

---

### Task 3: Result → owner DM with Post/Discard buttons

**Files:**
- Create: `src/channels/slack/job-results.js`
- Test: `tests/channels/job-results.test.js`
- Modify: `src/channels/slack/socket.js` (replace `_onJobResult` stub; register actions in `_setupListeners` next to the agenda actions from Plan B, or next to `sso_reseed_now` ~1703 if B not merged)

- [ ] **Step 1: Write the failing test**

```js
// tests/channels/job-results.test.js
const { buildReviewResultBlocks, handleJobAction } = require('../../src/channels/slack/job-results');
const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');

describe('buildReviewResultBlocks', () => {
    test('renders summary and carries job id on buttons', () => {
        const blocks = buildReviewResultBlocks({
            id: 5,
            payload_json: JSON.stringify({ repo: 'wego/payments', pr: 412, url: 'https://github.com/wego/payments/pull/412' }),
            result_json: JSON.stringify({ summary: '2 blocking, 3 nits', body_md: '## Review\n...' }),
        });
        const actions = blocks.find(b => b.type === 'actions');
        expect(actions.elements.map(e => e.action_id)).toEqual(['job_post_review', 'job_discard']);
        expect(actions.elements[0].value).toBe('5');
        expect(JSON.stringify(blocks)).toContain('2 blocking');
    });
});

describe('handleJobAction', () => {
    function setup() {
        const jobs = new Jobs(new Database(':memory:'));
        const row = jobs.enqueue('review', { repo: 'wego/payments', pr: 412 });
        const leased = jobs.lease('mac');
        jobs.complete(leased.id, leased.lease_id, { summary: 's', body_md: 'REVIEW BODY' });
        return { jobs, id: row.id };
    }

    test('job_post_review enqueues a post_review job carrying body_md', async () => {
        const { jobs, id } = setup();
        const reply = await handleJobAction({ actionId: 'job_post_review', value: String(id), jobs });
        const queued = jobs.lease('mac');
        expect(queued.kind).toBe('post_review');
        expect(JSON.parse(queued.payload_json).body_md).toBe('REVIEW BODY');
        expect(reply).toContain('queued');
    });

    test('job_discard replies without enqueuing', async () => {
        const { jobs, id } = setup();
        const reply = await handleJobAction({ actionId: 'job_discard', value: String(id), jobs });
        expect(jobs.lease('mac')).toBeNull();
        expect(reply).toContain('Discarded');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/channels/job-results.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/channels/slack/job-results.js`**

```js
/**
 * Job results → owner DM. Slack mrkdwn only. Suggest-only boundary lives
 * here: posting to GitHub happens ONLY via job_post_review, which is only
 * reachable from the owner's button tap, and executes on the Mac with the
 * owner's own gh auth.
 */
function buildReviewResultBlocks(jobRow) {
    const payload = JSON.parse(jobRow.payload_json);
    const result = JSON.parse(jobRow.result_json || '{}');
    const title = `${payload.repo}#${payload.pr}`;
    const preview = (result.body_md || '').slice(0, 2500);
    return [
        { type: 'section', text: { type: 'mrkdwn',
            text: `*Review draft ready:* <${payload.url || '#'}|${title}>\n_${result.summary || ''}_` } },
        { type: 'section', text: { type: 'mrkdwn', text: '```' + preview + '```' } },
        { type: 'actions', elements: [
            { type: 'button', action_id: 'job_post_review', style: 'primary',
              text: { type: 'plain_text', text: '📤 Post review' }, value: String(jobRow.id) },
            { type: 'button', action_id: 'job_discard',
              text: { type: 'plain_text', text: '🗑 Discard' }, value: String(jobRow.id) },
        ] },
    ];
}

async function handleJobAction({ actionId, value, jobs }) {
    const job = jobs.get(Number(value));
    if (!job) return `:warning: Job ${value} not found.`;
    const payload = JSON.parse(job.payload_json);
    const result = JSON.parse(job.result_json || '{}');

    switch (actionId) {
        case 'job_post_review': {
            const queued = jobs.enqueue('post_review',
                { repo: payload.repo, pr: payload.pr, body_md: result.body_md || '' },
                { dedupeKey: `post_review:${payload.repo}#${payload.pr}` });
            return queued
                ? `:outbox_tray: Post queued — it publishes from your Mac (as you) within ~10s of the lid being open.`
                : `:warning: A post for ${payload.repo}#${payload.pr} is already queued.`;
        }
        case 'job_discard':
            return `:wastebasket: Discarded — the draft stays in the job log if you change your mind (job ${job.id}).`;
        default:
            return `:warning: Unknown action ${actionId}.`;
    }
}

module.exports = { buildReviewResultBlocks, handleJobAction };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/channels/job-results.test.js -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Replace the `_onJobResult` stub + register buttons in socket.js**

```js
    async _onJobResult(job) {
        try {
            if (!this.config.ownerUserId) return;
            const dm = await this.app.client.conversations.open({ users: this.config.ownerUserId });
            if (job.kind === 'review') {
                await this.app.client.chat.postMessage({
                    channel: dm.channel.id, text: 'Review draft ready',
                    blocks: buildReviewResultBlocks(job), unfurl_links: false, unfurl_media: false,
                });
            } else if (job.kind === 'post_review') {
                const r = JSON.parse(job.result_json || '{}');
                await this.app.client.chat.postMessage({
                    channel: dm.channel.id, unfurl_links: false, unfurl_media: false,
                    text: r.review_url ? `:white_check_mark: Review posted: ${r.review_url}` : ':white_check_mark: Review posted.',
                });
            }
        } catch (err) {
            this.logger.error(`_onJobResult failed for job ${job.id}: ${err.message}`);
        }
    }
```

Requires at top: `const { buildReviewResultBlocks, handleJobAction } = require('./job-results');`

In `_setupListeners()`:

```js
        for (const actionId of ['job_post_review', 'job_discard']) {
            this.app.action(actionId, async ({ ack, body, action }) => {
                await ack();
                try {
                    const reply = await handleJobAction({ actionId, value: action.value, jobs: this.jobs });
                    await this.app.client.chat.postMessage({
                        channel: body.channel.id, text: reply, unfurl_links: false, unfurl_media: false,
                    });
                } catch (err) {
                    this.logger.error(`job action ${actionId} failed: ${err.message}`);
                }
            });
        }
```

- [ ] **Step 6: Full suite + commit**

```bash
npm test
git add src/channels/slack/job-results.js src/channels/slack/socket.js tests/channels/job-results.test.js
git commit -m "DM review drafts to owner with Post/Discard buttons"
```

---

### Task 4: jobs CLI (companion + human enqueue)

**Files:**
- Create: `scripts/jobs-cli.js`

Thin wrapper over the Jobs class (same pattern as Plan B's `agenda-cli.js`; no test — logic already covered by Task 1).

- [ ] **Step 1: Implement `scripts/jobs-cli.js`**

```js
#!/usr/bin/env node
/**
 * Jobs CLI — enqueue/inspect the Mac-runner queue.
 *   jobs-cli enqueue review --json '{"repo":"wego/payments","pr":412,"url":"..."}'
 *   jobs-cli list
 *   jobs-cli show <id>
 * DB path: JOBS_DB_PATH env, else the bot's slack-sessions.db.
 */
const path = require('path');
const Database = require('better-sqlite3');
const Jobs = require('../src/services/jobs');

const dbPath = process.env.JOBS_DB_PATH || path.join(__dirname, '../src/data/slack-sessions.db');
const jobs = new Jobs(new Database(dbPath));
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
    case 'enqueue': {
        const kind = args[0];
        const i = args.indexOf('--json');
        const payload = JSON.parse(args[i + 1]);
        const dedupeKey = kind === 'review' && payload.repo && payload.pr
            ? `review:${payload.repo}#${payload.pr}` : null;
        const row = jobs.enqueue(kind, payload, { dedupeKey });
        process.stdout.write(JSON.stringify(row || { deduped: true }) + '\n');
        break;
    }
    case 'list':
        process.stdout.write(JSON.stringify(jobs.recent(20), null, 2) + '\n');
        break;
    case 'show':
        process.stdout.write(JSON.stringify(jobs.get(Number(args[0])), null, 2) + '\n');
        break;
    default:
        process.stderr.write('usage: jobs-cli enqueue <kind> --json <payload> | list | show <id>\n');
        process.exit(1);
}
```

- [ ] **Step 2: Smoke test + commit**

```bash
JOBS_DB_PATH=/tmp/jobs-test.db node scripts/jobs-cli.js enqueue review --json '{"repo":"a/b","pr":1}'
JOBS_DB_PATH=/tmp/jobs-test.db node scripts/jobs-cli.js list   # shows 1 pending row
git add scripts/jobs-cli.js
git commit -m "Add jobs CLI"
```

---

### Task 5: Review prompt builder (Mac side)

**Files:**
- Create: `runner/prompts.js`
- Test: `tests/runner/prompts.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/runner/prompts.test.js
const { buildReviewPrompt } = require('../../runner/prompts');

describe('buildReviewPrompt', () => {
    test('contains repo, PR number, result path, and the safety rules', () => {
        const p = buildReviewPrompt(
            { repo: 'wego/payments', pr: 412, url: 'https://github.com/wego/payments/pull/412' },
            '/Users/enzo/enzobot-jobs/5/result.md',
            '/Users/enzo/go/src/github.com/payments'
        );
        expect(p).toContain('wego/payments');
        expect(p).toContain('412');
        expect(p).toContain('/Users/enzo/enzobot-jobs/5/result.md');
        expect(p).toContain('git worktree');          // isolation rule
        expect(p).toMatch(/do not post|never post/i); // suggest-only rule
        expect(p).toContain('RESULT_READY');           // completion marker
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/runner/prompts.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `runner/prompts.js`**

```js
/**
 * Prompt builders for Mac runner jobs. The prompt is the contract with the
 * Claude Code TUI running in the herdr pane: isolate in a worktree, never
 * touch the user's working tree, never post to GitHub, write the result to
 * a file and print RESULT_READY as the final line.
 */
function buildReviewPrompt(payload, resultPath, checkoutPath) {
    return [
        `Review pull request ${payload.repo}#${payload.pr} (${payload.url || ''}).`,
        ``,
        `Rules (non-negotiable):`,
        `- Work read-only with respect to my checkout at ${checkoutPath}: create a`,
        `  git worktree (git -C ${checkoutPath} worktree add <tmpdir> FETCH_HEAD after`,
        `  fetching the PR head) and review inside it; remove the worktree when done.`,
        `- Do NOT post anything to GitHub. No gh pr review, no comments. Draft only.`,
        `- Do NOT modify my working tree, branches, or any remote.`,
        ``,
        `Review focus: correctness bugs first, then security, then tests, then style.`,
        `Read the full diff AND enough surrounding code to judge correctness.`,
        ``,
        `Write the finished review as GitHub-flavored markdown to: ${resultPath}`,
        `Format: one-line verdict, then ## Blocking, ## Suggestions, ## Nits sections`,
        `(omit empty sections). Then write a one-line summary (counts per section) to`,
        `${resultPath}.summary. When both files are written, print exactly:`,
        `RESULT_READY`,
    ].join('\n');
}

module.exports = { buildReviewPrompt };
```

- [ ] **Step 4: Run test + commit**

```bash
npx jest tests/runner/prompts.test.js -v   # PASS
git add runner/prompts.js tests/runner/prompts.test.js
git commit -m "Add review prompt builder for Mac runner"
```

---

### Task 6: herdr execution wrapper (Mac side)

**Files:**
- Create: `runner/herdr-exec.js`

**No jest test** — this module is a thin shell over the herdr CLI and is verified by the live checklist in Task 8 (mocking `execFile` here would test nothing real). Keep every herdr call in this one file.

- [ ] **Step 1: Discover current herdr CLI syntax (the installed binary is the authority)**

Run each and note the exact flags for: workspace create with a label, tab create in a workspace with a cwd, pane run, wait agent-status, pane read:

```bash
herdr workspace
herdr tab
herdr pane
herdr wait
```

Expected: JSON-emitting subcommands. **Adapt the code in Step 2 to the real flags** — do not trust the snippet's guesses over the binary's help output.

- [ ] **Step 2: Implement `runner/herdr-exec.js`** (structure below; flag spellings from Step 1)

```js
/**
 * herdr pane lifecycle for runner jobs. Etiquette: we operate ONLY inside
 * the workspace labeled 'enzobot' (created on demand). All IDs are read
 * from herdr JSON responses — never constructed. Panes stay open after a
 * job for the owner to inspect; each new job closes panes we created more
 * than KEEP_PANES jobs ago (tracked in memory per daemon lifetime).
 */
const { execFileSync } = require('child_process');

const WORKSPACE_LABEL = 'enzobot';

function herdr(...args) {
    const out = execFileSync('herdr', args, { encoding: 'utf8', timeout: 30_000 });
    try { return JSON.parse(out); } catch { return out; }
}

function ensureWorkspace() {
    const list = herdr('workspace', 'list');
    const found = (list.result?.workspaces || []).find(w => w.label === WORKSPACE_LABEL);
    if (found) return found.workspace_id;
    const created = herdr('workspace', 'create', '--label', WORKSPACE_LABEL); // flags per Step 1
    return created.result.workspace_id; // read from response, never guess
}

function createJobPane(workspaceId, { label, cwd }) {
    const tab = herdr('tab', 'create', '--workspace', workspaceId, '--label', label, '--cwd', cwd);
    // Read the pane id from the response (a new tab carries its first pane).
    const paneId = tab.result.pane_id || tab.result.panes?.[0]?.pane_id;
    if (!paneId) throw new Error('could not read pane id from tab create response');
    return { paneId, tabId: tab.result.tab_id };
}

function startAgent(paneId, cliCommand) {
    herdr('pane', 'run', paneId, cliCommand);                       // launch bare TUI
    herdr('wait', 'agent-status', paneId, '--status', 'idle', '--timeout', '60000');
}

function submitTask(paneId, prompt) {
    herdr('pane', 'run', paneId, prompt);                            // text + Enter
    herdr('wait', 'agent-status', paneId, '--status', 'working', '--timeout', '30000');
}

function waitDone(paneId, timeoutMs) {
    // Completion is 'done' normally, 'idle' if the owner has the tab focused.
    try {
        herdr('wait', 'agent-status', paneId, '--status', 'done', '--timeout', String(timeoutMs));
    } catch {
        herdr('wait', 'agent-status', paneId, '--status', 'idle', '--timeout', '5000');
    }
}

function readTail(paneId, lines = 200) {
    return herdr('pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines));
}

function closePane(paneId) {
    try { herdr('pane', 'close', paneId); } catch { /* already gone */ }
}

module.exports = { ensureWorkspace, createJobPane, startAgent, submitTask, waitDone, readTail, closePane, WORKSPACE_LABEL };
```

- [ ] **Step 3: Live smoke test (safe — only touches the enzobot workspace)**

```bash
node -e "
const hx = require('./runner/herdr-exec');
const ws = hx.ensureWorkspace();
const { paneId } = hx.createJobPane(ws, { label: 'smoke', cwd: process.env.HOME });
hx.startAgent(paneId, 'claude');
hx.submitTask(paneId, 'Say READY and nothing else.');
hx.waitDone(paneId, 120000);
console.log(hx.readTail(paneId, 40));
"
```

Expected: a new `enzobot` workspace appears in herdr with a `smoke` tab; the pane shows Claude answering READY; the script prints the pane tail. Close the tab manually after.

- [ ] **Step 4: Commit**

```bash
git add runner/herdr-exec.js
git commit -m "Add herdr pane lifecycle wrapper for Mac runner"
```

---

### Task 7: Runner daemon (Mac side)

**Files:**
- Create: `runner/enzobot-runner.js`
- Test: `tests/runner/runner.test.js` (the pure job-execution routing, exec mocked)

- [ ] **Step 1: Write the failing test**

```js
// tests/runner/runner.test.js
const { executeJob } = require('../../runner/enzobot-runner');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('executeJob', () => {
    test('review job: spawns pane, waits, reads result files', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const job = { id: 5, kind: 'review',
            payload_json: JSON.stringify({ repo: 'wego/payments', pr: 412 }) };
        const hx = {
            ensureWorkspace: jest.fn().mockReturnValue('w9'),
            createJobPane: jest.fn().mockReturnValue({ paneId: 'w9:p1' }),
            startAgent: jest.fn(), submitTask: jest.fn(),
            waitDone: jest.fn(() => {
                fs.writeFileSync(path.join(jobsDir, '5', 'result.md'), '## Review\nLGTM');
                fs.writeFileSync(path.join(jobsDir, '5', 'result.md.summary'), '0 blocking');
            }),
            readTail: jest.fn().mockReturnValue('RESULT_READY'),
        };
        const cfg = { jobsDir, repoRoot: '/tmp', repoMap: { 'wego/payments': '/tmp/payments' }, cliCommand: 'claude' };
        const result = await executeJob(job, cfg, hx, { execFileSync: jest.fn() });
        expect(result.body_md).toContain('LGTM');
        expect(result.summary).toBe('0 blocking');
        expect(hx.submitTask).toHaveBeenCalled();
    });

    test('post_review job: calls gh with body file, no pane', async () => {
        const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejobs-'));
        const gh = jest.fn().mockReturnValue('');
        const job = { id: 6, kind: 'post_review',
            payload_json: JSON.stringify({ repo: 'wego/payments', pr: 412, body_md: 'REVIEW' }) };
        const result = await executeJob(job, { jobsDir, repoMap: {} }, {}, { execFileSync: gh });
        expect(gh).toHaveBeenCalledWith('gh',
            expect.arrayContaining(['pr', 'review', '412', '--repo', 'wego/payments', '--comment']),
            expect.anything());
        expect(result.posted).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/runner/runner.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `runner/enzobot-runner.js`**

```js
#!/usr/bin/env node
/**
 * EnzoBot Mac runner — polls the VPS queue, executes jobs in herdr panes,
 * reports results. Dependency-free (Node stdlib + global fetch) so it runs
 * from a bare checkout under launchd.
 *
 * Config: ~/.enzobot-runner.json
 *   { "vpsUrl": "https://vps:9999", "token": "...", "repoRoot": "~/go/src/github.com",
 *     "repoMap": { "wego/payments": "~/go/src/github.com/payments" },
 *     "pollMs": 10000, "cliCommand": "claude", "jobTimeoutMs": 1500000 }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const hxDefault = require('./herdr-exec');
const { buildReviewPrompt } = require('./prompts');

function loadConfig() {
    const p = path.join(os.homedir(), '.enzobot-runner.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const expand = (s) => s && s.replace(/^~/, os.homedir());
    cfg.repoRoot = expand(cfg.repoRoot);
    for (const k of Object.keys(cfg.repoMap || {})) cfg.repoMap[k] = expand(cfg.repoMap[k]);
    cfg.jobsDir = expand(cfg.jobsDir || '~/enzobot-jobs');
    cfg.pollMs = cfg.pollMs || 10_000;
    cfg.cliCommand = cfg.cliCommand || 'claude';
    cfg.jobTimeoutMs = cfg.jobTimeoutMs || 25 * 60_000;
    return cfg;
}

function repoPath(cfg, repo) {
    if (cfg.repoMap && cfg.repoMap[repo]) return cfg.repoMap[repo];
    const guess = path.join(cfg.repoRoot, repo.split('/')[1]);
    if (fs.existsSync(guess)) return guess;
    throw new Error(`no local checkout for ${repo} (add it to repoMap)`);
}

/** Exported for tests. hx + execFileSync injectable. */
async function executeJob(job, cfg, hx, { execFileSync = childProcess.execFileSync } = {}) {
    const payload = JSON.parse(job.payload_json);

    if (job.kind === 'post_review') {
        const bodyFile = path.join(cfg.jobsDir, String(job.id), 'post-body.md');
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, payload.body_md || '');
        execFileSync('gh', ['pr', 'review', String(payload.pr), '--repo', payload.repo,
            '--comment', '--body-file', bodyFile], { encoding: 'utf8', timeout: 60_000 });
        return { posted: true };
    }

    if (job.kind === 'review') {
        const dir = path.join(cfg.jobsDir, String(job.id));
        fs.mkdirSync(dir, { recursive: true });
        const resultPath = path.join(dir, 'result.md');
        const checkout = repoPath(cfg, payload.repo);

        const ws = hx.ensureWorkspace();
        const { paneId } = hx.createJobPane(ws, { label: `review-${payload.pr}`, cwd: checkout });
        hx.startAgent(paneId, cfg.cliCommand);
        hx.submitTask(paneId, buildReviewPrompt(payload, resultPath, checkout));
        hx.waitDone(paneId, cfg.jobTimeoutMs);

        if (!fs.existsSync(resultPath)) {
            throw new Error('result.md missing; pane tail: ' + String(hx.readTail(paneId, 60)).slice(-1500));
        }
        return {
            body_md: fs.readFileSync(resultPath, 'utf8'),
            summary: fs.existsSync(resultPath + '.summary')
                ? fs.readFileSync(resultPath + '.summary', 'utf8').trim() : 'review ready',
            pane_id: paneId,
        };
    }

    throw new Error(`unknown job kind ${job.kind}`);
}

async function pollOnce(cfg, hx) {
    const api = (route, body) => fetch(cfg.vpsUrl + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runner-token': cfg.token },
        body: JSON.stringify(body),
    }).then(r => r.json());

    const { job } = await api('/runner/lease', { target: 'mac' });
    if (!job) return false;
    console.log(`[runner] leased job ${job.id} (${job.kind})`);
    try {
        const result = await executeJob(job, cfg, hx);
        await api('/runner/complete', { job_id: job.id, lease_id: job.lease_id, result });
        console.log(`[runner] job ${job.id} done`);
    } catch (err) {
        console.error(`[runner] job ${job.id} failed: ${err.message}`);
        await api('/runner/fail', { job_id: job.id, lease_id: job.lease_id, error: err.message });
    }
    return true;
}

async function main() {
    const cfg = loadConfig();
    console.log(`[runner] polling ${cfg.vpsUrl} every ${cfg.pollMs}ms`);
    for (;;) {
        try { await pollOnce(cfg, hxDefault); }
        catch (err) { console.error(`[runner] poll error: ${err.message}`); }
        await new Promise(r => setTimeout(r, cfg.pollMs));
    }
}

if (require.main === module) main();
module.exports = { executeJob, pollOnce };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/runner/runner.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add runner/enzobot-runner.js tests/runner/runner.test.js
git commit -m "Add Mac runner daemon (poll, execute in herdr, report)"
```

---### Task 8: launchd install + Mac live checklist

**Files:**
- Create: `runner/com.enzo.enzobot-runner.plist`
- Create: `runner/README.md`

- [ ] **Step 1: Create `runner/com.enzo.enzobot-runner.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.enzo.enzobot-runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>__REPO__/runner/enzobot-runner.js</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/enzobot-runner.log</string>
    <key>StandardErrorPath</key><string>/tmp/enzobot-runner.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Create `runner/README.md`**

```markdown
# EnzoBot Mac Runner

## Install (once, on the Mac)

1. `~/.enzobot-runner.json`:
   { "vpsUrl": "http://<vps-host>:9999", "token": "<RUNNER_TOKEN from VPS .env>",
     "repoRoot": "~/go/src/github.com",
     "repoMap": { "wego/payments": "~/go/src/github.com/payments" },
     "cliCommand": "claude" }
2. Check node path: `which node` — edit the plist's ProgramArguments if not /usr/local/bin/node.
3. `sed "s|__REPO__|$(pwd)|" runner/com.enzo.enzobot-runner.plist > ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist`
4. `launchctl load ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist`
5. `tail -f /tmp/enzobot-runner.log` → "polling http://…"

Requirements on the Mac: herdr server running, `gh auth status` OK, repos cloned.
Uninstall: `launchctl unload ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist`
```

- [ ] **Step 3: Live end-to-end checklist (VPS + Mac)**

```bash
# VPS: RUNNER_TOKEN=<random> in .env, npm run restart
# VPS: enqueue a real review job
curl -s -X POST http://localhost:9999/jobs -H 'content-type: application/json' \
  -H "x-runner-token: $RUNNER_TOKEN" \
  -d '{"kind":"review","payload":{"repo":"<org>/<repo>","pr":<open PR #>,"url":"<pr url>"}}'
# Mac: within ~10s the runner log shows "leased job 1 (review)";
#      a review-<pr> tab appears in the enzobot herdr workspace — watch it work
# Slack: draft review DM arrives with [📤 Post review] [🗑 Discard]
# Tap Post → within ~10s gh posts the review as you; confirmation DM arrives
# Lid test: close lid, enqueue another job, wait 1 min, open lid → job drains
```

- [ ] **Step 4: Commit**

```bash
git add runner/com.enzo.enzobot-runner.plist runner/README.md
git commit -m "Add launchd template and Mac runner install guide"
```

---

### Task 9: Auto-enqueue on review request (the "auto" in auto-review)

**Files:**
- Modify: `start-slack-socket.js` (config ~49 + scheduling ~298)
- Modify: `src/channels/slack/socket.js` (one method)
- Modify: `.env.example`

Reuses Plan B's GitHub collector if merged; otherwise inline the same search call. Dedupe is free: the jobs `dedupe_key` (`review:<repo>#<pr>`) means a PR is drafted once per life of the job row.

- [ ] **Step 1: Add the sweep method in socket.js**

```js
    /**
     * Entity Plan D: poll GitHub for PRs where the owner's review is
     * requested; enqueue a review job for each (dedupe via jobs dedupe_key).
     */
    async _sweepReviewRequests() {
        const token = process.env.GITHUB_TOKEN;
        if (!token) return;
        const resp = await fetch('https://api.github.com/search/issues?q=' +
            encodeURIComponent('is:pr is:open review-requested:@me archived:false draft:false') + '&per_page=20', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'enzobot' },
        });
        if (!resp.ok) { this.logger.warn(`review sweep: GitHub ${resp.status}`); return; }
        const items = (await resp.json()).items || [];
        for (const it of items) {
            const m = it.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
            if (!m) continue;
            const row = this.jobs.enqueue('review',
                { repo: m[1], pr: Number(m[2]), url: it.html_url, requested_by: 'auto-sweep' },
                { dedupeKey: `review:${m[1]}#${m[2]}` });
            if (row) this.logger.info(`auto-review enqueued: ${m[1]}#${m[2]} (job ${row.id})`);
        }
    }
```

- [ ] **Step 2: Schedule it in `start-slack-socket.js`**

Config object (~49): `autoReviewEnabled: process.env.AUTO_REVIEW_ENABLED === 'true', autoReviewIntervalMin: Number(process.env.AUTO_REVIEW_INTERVAL_MIN || 15),`

Near the other schedulers (~298):

```js
    if (config.autoReviewEnabled) {
        setInterval(() => {
            handler._sweepReviewRequests().catch(err => logger.error(`review sweep failed: ${err.message}`));
        }, config.autoReviewIntervalMin * 60_000).unref();
        logger.info(`Auto-review sweep every ${config.autoReviewIntervalMin}m`);
    }
```

- [ ] **Step 3: `.env.example`**

```bash
# ── Entity Plan D: Mac runner + auto-review ──────────────────────────
# Shared secret between VPS endpoints and the Mac runner (openssl rand -hex 24)
RUNNER_TOKEN=
# Poll GitHub for review-requested PRs and auto-draft reviews on the Mac
AUTO_REVIEW_ENABLED=false
AUTO_REVIEW_INTERVAL_MIN=15
```

- [ ] **Step 4: Full suite, live verify, commit, push**

```bash
npm test
# live: flip AUTO_REVIEW_ENABLED=true on VPS, restart, ask a teammate (or a
# second account) to request your review on a test PR → draft DM arrives
# within (interval + job runtime) without any manual step.
git add start-slack-socket.js src/channels/slack/socket.js .env.example
git commit -m "Auto-enqueue review drafts when review is requested"
git pull --rebase && git push
```

---

## Self-review notes (done at plan time)

- **Spec coverage vs the locked design:** queue+poll link (T1/T2/T7), watchable herdr execution with agent-status completion (T6/T7), draft-then-tap-to-post with owner-only outward action via Mac gh (T3/T7), auto-detection of review requests (T9), no write creds on VPS (post_review runs on Mac), sleep-safety (lease TTL + retry, T1; lid test, T8).
- **herdr flag risk:** exact CLI flags for `workspace create`/`tab create` are discovered in T6 Step 1 from the installed binary (the skill names it the authority); the code snippets mark every guessed flag. The live smoke test in T6 Step 3 catches any drift before the daemon exists.
- **Type consistency:** job row fields (`payload_json`/`result_json`/`lease_id`) are used identically in Jobs (T1), endpoints (T2), job-results (T3), CLI (T4), runner (T7). Review result contract `{summary, body_md}` produced in T7 matches T3's consumers; `RESULT_READY` marker produced by the prompt (T5) is only informational (file existence is the real signal).
- **Plan B interaction:** no shared files beyond socket.js insertion points, both plans use additive wiring at `_initDb`/`_setupListeners`/HTTP section; either order of execution works.
