# EnzoBot Plan E — Night Work Cycle + Home Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The 22:00 plan→approve→overnight-work→06:00 report cycle, plus the nightly self-improvement ratchet and the full App Home control board.

**Repository:** `Claude-Code-Remote` (Node.js). No other repo touched.

**Provider APIs:** **None new.** All reasoning (writing the night plan, grounding the 06:00 report, the ratchet's propose step) happens inside the resident companion Claude Code session — we inject a prompt and read its reply. The quota estimate is pure arithmetic (job count × per-kind cost constant). Do NOT add any LLM SDK call in this plan.

**Depends on:** Plan B (companion, agenda, `_injectCompanionPrompt`, `POST /pulse`) and Plan D (jobs queue `this.jobs`, runner). Both must be merged first.

**Architecture:** Two new scheduled pulses injected into the companion (22:00, 06:00) plus a nightly ratchet pulse. The companion does the thinking via its chief-of-staff-style skills; new SQLite tables (`night_plans`, `ratchet_log`) hold the durable state the pulses read/write. The Home board grows from the v0 renderer already shipped.

---

## File structure

| File | Responsibility |
|---|---|
| `src/services/night-plan.js` (new) | `night_plans` table + CRUD (plan, budget, approval state) |
| `src/services/ratchet.js` (new) | `ratchet_log` table + metric capture + change/revert records |
| `src/services/quota.js` (new) | Heuristic quota estimator (pure arithmetic) |
| `src/channels/slack/night-actions.js` (new) | Approve/Edit/Skip button handlers |
| `src/channels/slack/home-tab.js` (modify) | Add Tonight / Jobs / Agenda / Rules sections + view-switcher |
| `src/channels/slack/socket.js` (modify) | Register night buttons + home switcher; `POST /night/plan`, `/night/report` |
| `start-slack-socket.js` (modify) | `scheduleNightPlan` (22:00), `scheduleMorningReport` (06:00), `scheduleRatchet` |
| `companion/skills/night-planner/SKILL.md` (new) | Guides the 22:00 planning turn |
| `companion/skills/morning-reporter/SKILL.md` (new) | Guides the 06:00 grounded report |
| `companion/skills/ratchet/SKILL.md` (new) | Guides the nightly self-improvement turn |
| `.env.example` (modify) | Times + `RATCHET_ENABLED`, `NIGHT_WHITELIST` |

---

### Task 1: Quota estimator (pure, testable)

**Files:** Create `src/services/quota.js`; Test `tests/services/quota.test.js`

- [ ] **Step 1: Failing test**

```js
// tests/services/quota.test.js
const { estimatePlan, fitsBudget } = require('../../src/services/quota');
describe('quota', () => {
  test('estimates cost from job kinds', () => {
    const est = estimatePlan([{ kind: 'review' }, { kind: 'review' }, { kind: 'analysis' }]);
    expect(est.jobs).toBe(3);
    expect(est.estTokens).toBeGreaterThan(0);
  });
  test('fitsBudget compares estimate to a nightly ceiling', () => {
    expect(fitsBudget({ estTokens: 100 }, 1000)).toBe(true);
    expect(fitsBudget({ estTokens: 5000 }, 1000)).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement `src/services/quota.js`

```js
/**
 * Heuristic quota estimator. NOT a provider API call — pure arithmetic.
 * Per-kind token cost constants are rough averages, refined later (v1.5)
 * from measured usage. The nightly ceiling comes from NIGHT_TOKEN_BUDGET env.
 */
const COST = { review: 120_000, analysis: 60_000, report_prep: 30_000, custom: 50_000 };

function estimatePlan(jobs = []) {
  const estTokens = jobs.reduce((s, j) => s + (COST[j.kind] || COST.custom), 0);
  return { jobs: jobs.length, estTokens };
}
function fitsBudget(est, ceilingTokens) { return est.estTokens <= ceilingTokens; }

module.exports = { estimatePlan, fitsBudget, COST };
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: heuristic nightly quota estimator`.

---

### Task 2: Night-plan store

**Files:** Create `src/services/night-plan.js`; Test `tests/services/night-plan.test.js`; Modify `socket.js` `_initDb` (add `this.nightPlan = new NightPlan(this.db)`).

- [ ] **Step 1: Failing test**

```js
// tests/services/night-plan.test.js
const Database = require('better-sqlite3');
const NightPlan = require('../../src/services/night-plan');
const create = () => new NightPlan(new Database(':memory:'));
describe('NightPlan', () => {
  test('create → get latest returns pending plan with jobs+budget', () => {
    const np = create();
    const p = np.create({ dateKey: '2026-07-28', jobs: [{ kind: 'review', ref: 'x#1' }], budget: { estTokens: 120000, fits: true } });
    const latest = np.latest();
    expect(latest.id).toBe(p.id);
    expect(latest.status).toBe('pending');
    expect(JSON.parse(latest.jobs_json)).toHaveLength(1);
  });
  test('approve/skip transitions', () => {
    const np = create();
    const p = np.create({ dateKey: 'd', jobs: [], budget: {} });
    np.setStatus(p.id, 'approved');
    expect(np.get(p.id).status).toBe('approved');
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/services/night-plan.js`

```js
/**
 * night_plans — one row per night. The companion writes the plan at 22:00
 * (status 'pending'); the owner's Approve/Edit/Skip button transitions it;
 * the executor reads 'approved' rows to enqueue jobs.
 */
class NightPlan {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS night_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_key TEXT NOT NULL,
      jobs_json TEXT NOT NULL DEFAULT '[]',
      budget_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    this._s = {
      insert: db.prepare(`INSERT INTO night_plans (date_key, jobs_json, budget_json, created_at, updated_at)
                          VALUES (@date_key,@jobs_json,@budget_json,@now,@now)`),
      get: db.prepare('SELECT * FROM night_plans WHERE id = ?'),
      latest: db.prepare('SELECT * FROM night_plans ORDER BY id DESC LIMIT 1'),
      setStatus: db.prepare('UPDATE night_plans SET status=?, updated_at=? WHERE id=?'),
      setJobs: db.prepare('UPDATE night_plans SET jobs_json=?, updated_at=? WHERE id=?'),
    };
  }
  create({ dateKey, jobs, budget }) {
    const info = this._s.insert.run({ date_key: dateKey, jobs_json: JSON.stringify(jobs || []),
      budget_json: JSON.stringify(budget || {}), now: Date.now() });
    return this._s.get.get(info.lastInsertRowid);
  }
  get(id) { return this._s.get.get(id); }
  latest() { return this._s.latest.get(); }
  setStatus(id, status) { this._s.setStatus.run(status, Date.now(), id); }
  setJobs(id, jobs) { this._s.setJobs.run(JSON.stringify(jobs), Date.now(), id); }
}
module.exports = NightPlan;
```

- [ ] **Step 4:** Run → PASS. Wire `this.nightPlan = new NightPlan(this.db)` in `_initDb`.
- [ ] **Step 5:** Commit.

---

### Task 3: Ratchet store + metrics

**Files:** Create `src/services/ratchet.js`; Test `tests/services/ratchet.test.js`.

Records one row per nightly self-improvement attempt: the metrics observed, the single change proposed, and (next day) whether it was kept or reverted. The change itself is applied elsewhere (a directive via Plan A, or a config value); this table is the audit log + revert source.

- [ ] **Step 1: Failing test**

```js
// tests/services/ratchet.test.js
const Database = require('better-sqlite3');
const Ratchet = require('../../src/services/ratchet');
const create = () => new Ratchet(new Database(':memory:'));
describe('Ratchet', () => {
  test('record proposal then resolve keep/revert', () => {
    const r = create();
    const row = r.propose({ metrics: { editDistance: 0.4 }, change: 'lower brief size to 2', target: 'config:briefSize' });
    r.resolve(row.id, 'kept');
    expect(r.get(row.id).outcome).toBe('kept');
  });
  test('lastKept returns most recent kept change for a target', () => {
    const r = create();
    const a = r.propose({ metrics: {}, change: 'x', target: 't' }); r.resolve(a.id, 'reverted');
    const b = r.propose({ metrics: {}, change: 'y', target: 't' }); r.resolve(b.id, 'kept');
    expect(r.lastKept('t').change).toBe('y');
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/services/ratchet.js`

```js
/**
 * ratchet_log — the Karpathy loop applied to the Entity itself. One row per
 * night: metrics observed, ONE bounded change proposed, outcome resolved the
 * following night (kept if metrics improved, reverted otherwise). Pure store;
 * the companion decides the change, the applier (directive/config) enacts it.
 */
class Ratchet {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS ratchet_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      change TEXT NOT NULL, target TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    this._s = {
      insert: db.prepare(`INSERT INTO ratchet_log (metrics_json, change, target, created_at, updated_at)
                          VALUES (@m,@c,@t,@now,@now)`),
      get: db.prepare('SELECT * FROM ratchet_log WHERE id = ?'),
      resolve: db.prepare('UPDATE ratchet_log SET outcome=?, updated_at=? WHERE id=?'),
      lastKept: db.prepare("SELECT * FROM ratchet_log WHERE target=? AND outcome='kept' ORDER BY id DESC LIMIT 1"),
      openForTarget: db.prepare("SELECT * FROM ratchet_log WHERE target=? AND outcome='open' ORDER BY id DESC LIMIT 1"),
    };
  }
  propose({ metrics, change, target }) {
    const info = this._s.insert.run({ m: JSON.stringify(metrics || {}), c: change, t: target, now: Date.now() });
    return this._s.get.get(info.lastInsertRowid);
  }
  get(id) { return this._s.get.get(id); }
  resolve(id, outcome) { this._s.resolve.run(outcome, Date.now(), id); }
  lastKept(target) { return this._s.lastKept.get(target); }
  openForTarget(target) { return this._s.openForTarget.get(target); }
}
module.exports = Ratchet;
```

- [ ] **Step 4:** Run → PASS. Wire `this.ratchet = new Ratchet(this.db)` in `_initDb`.
- [ ] **Step 5:** Commit.

---

### Task 4: Night-plan buttons (Approve / Edit / Skip)

**Files:** Create `src/channels/slack/night-actions.js`; Test `tests/channels/night-actions.test.js`; register in `socket.js` `_setupListeners`.

- [ ] **Step 1: Failing test**

```js
// tests/channels/night-actions.test.js
const Database = require('better-sqlite3');
const NightPlan = require('../../src/services/night-plan');
const Jobs = require('../../src/services/jobs');
const { handleNightAction } = require('../../src/channels/slack/night-actions');
function setup() {
  const db = new Database(':memory:');
  const nightPlan = new NightPlan(db), jobs = new Jobs(db);
  const p = nightPlan.create({ dateKey: 'd', jobs: [{ kind: 'review', repo: 'a/b', pr: 1 }], budget: { fits: true } });
  return { nightPlan, jobs, id: p.id };
}
describe('handleNightAction', () => {
  test('approve enqueues all plan jobs and marks approved', async () => {
    const { nightPlan, jobs, id } = setup();
    const reply = await handleNightAction({ actionId: 'night_approve', value: String(id), nightPlan, jobs });
    expect(nightPlan.get(id).status).toBe('approved');
    expect(jobs.lease('mac')).not.toBeNull();
    expect(reply).toContain('Approved');
  });
  test('skip marks skipped, enqueues nothing', async () => {
    const { nightPlan, jobs, id } = setup();
    await handleNightAction({ actionId: 'night_skip', value: String(id), nightPlan, jobs });
    expect(nightPlan.get(id).status).toBe('skipped');
    expect(jobs.lease('mac')).toBeNull();
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/channels/slack/night-actions.js`

```js
/**
 * Night-plan button handlers. Approve → enqueue every job in the plan onto the
 * jobs queue (Plan D). Edit → tell the user to reply in the DM (the companion
 * revises the plan conversationally, then re-posts). Skip → mark skipped.
 */
async function handleNightAction({ actionId, value, nightPlan, jobs }) {
  const plan = nightPlan.get(Number(value));
  if (!plan) return `:warning: Night plan ${value} not found.`;
  switch (actionId) {
    case 'night_approve': {
      const list = JSON.parse(plan.jobs_json);
      for (const j of list) {
        const key = j.repo && j.pr ? `${j.kind}:${j.repo}#${j.pr}` : null;
        jobs.enqueue(j.kind, j, { dedupeKey: key, target: j.target || 'mac' });
      }
      nightPlan.setStatus(plan.id, 'approved');
      return `:white_check_mark: Approved — ${list.length} job(s) queued for tonight.`;
    }
    case 'night_skip':
      nightPlan.setStatus(plan.id, 'skipped');
      return `:double_vertical_bar: Skipped tonight. Nothing will run.`;
    case 'night_edit':
      return `:pencil2: Reply here with your change (e.g. "drop the analysis, add review #421") and I'll re-post the plan.`;
    default:
      return `:warning: Unknown action ${actionId}.`;
  }
}
module.exports = { handleNightAction };
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Register in `_setupListeners` (mirror Plan B agenda-button loop):

```js
for (const actionId of ['night_approve', 'night_edit', 'night_skip']) {
  this.app.action(actionId, async ({ ack, body, action }) => {
    await ack();
    try {
      const reply = await handleNightAction({ actionId, value: action.value, nightPlan: this.nightPlan, jobs: this.jobs });
      await this.app.client.chat.postMessage({ channel: body.channel.id, text: reply, unfurl_links: false, unfurl_media: false });
    } catch (err) { this.logger.error(`night action ${actionId} failed: ${err.message}`); }
  });
}
```

Require `const { handleNightAction } = require('./night-actions');`.

- [ ] **Step 6:** Commit.

---

### Task 5: The three companion skills (planner / reporter / ratchet)

**Files:** Create the three `companion/skills/*/SKILL.md`. These are prompts the companion follows — no code, no tests. They are the "smart" (executed by the Claude Code session), not API calls.

- [ ] **Step 1:** `companion/skills/night-planner/SKILL.md`

```markdown
---
name: night-planner
description: 22:00 — analyze the day, draft tonight's work plan, check quota, post for approval
---
# Night Planner (runs at 22:00)
1. Analyze since yesterday 22:00: `agenda-cli list`, open PRs needing review
   (collect.js), tickets that moved, stale threads. Use graph context for relations.
2. Choose tonight's jobs. Each job: { kind: review|analysis|report_prep, repo?, pr?, ref, target: mac|vps }.
   Mac-only work (touches repos/gh) → target mac; API-only analysis → target vps.
3. Estimate budget: `node $ENZOBOT_REPO/scripts/night-cli.js estimate --json '<jobs>'`.
4. Persist the plan: `node $ENZOBOT_REPO/scripts/night-cli.js create --date <YYYY-MM-DD> --json '<jobs>' --budget '<est>'`.
   It prints the plan id.
5. Post the plan to the DM with Approve/Edit/Skip buttons:
   `node $ENZOBOT_REPO/scripts/night-cli.js post <planId>`.
6. If quota does NOT fit, trim lowest-priority jobs until it does and say so in the post.
```

- [ ] **Step 2:** `companion/skills/morning-reporter/SKILL.md`

```markdown
---
name: morning-reporter
description: 06:00 — collect night results, GROUND every claim, post the report + today's plan
---
# Morning Reporter (runs at 06:00)
1. Read completed jobs: `node $ENZOBOT_REPO/scripts/jobs-cli.js list`.
2. For each result, GROUND it: a claim like "reviewed #418, 2 blocking" must cite the
   job's result artifact; "ranked #1 because Sarah blocked" must cite a graph path.
   Drop any claim you cannot ground — do not invent.
3. Reconcile agenda (close resolved, add new). Rank today's top items.
4. Post the report: night results (with the Post/Discard buttons for review drafts) +
   today's ranked plan. Use the brief poster.
5. State one line of reasoning for the #1 item (so the conversation remembers why).
```

- [ ] **Step 3:** `companion/skills/ratchet/SKILL.md`

```markdown
---
name: ratchet
description: nightly — measure yourself, propose ONE bounded improvement, keep or revert
---
# Ratchet (runs nightly, after the reporter)
1. First resolve yesterday's open proposal: compare today's metrics to when it was made.
   `node $ENZOBOT_REPO/scripts/ratchet-cli.js resolve <id> keep|revert`. On revert, undo
   the change (supersede the directive / restore the config).
2. Measure: interrupt precision (pings acted-on / sent), brief quality (did Enzo do #1
   first?), draft edit-distance (his edits before posting), job success rate, quota efficiency.
3. Propose ONE bounded change: a directive (via Plan A's directive-cli) OR a config value
   (briefSize, interrupt threshold, ranking weight). Never a code change — if code is the
   fix, draft a PR suggestion for tomorrow's report instead.
4. Record it: `node $ENZOBOT_REPO/scripts/ratchet-cli.js propose --json '<metrics>' --change '<text>' --target '<id>'`.
5. Apply the change (reversible). Never touch more than one thing per night.
```

- [ ] **Step 4:** Commit all three.

---

### Task 6: `night-cli.js` + `ratchet-cli.js`

**Files:** Create `scripts/night-cli.js`, `scripts/ratchet-cli.js`. Thin wrappers over the stores + quota + brief poster (pattern = Plan B's `agenda-cli.js`). No unit tests (logic covered by store tests); smoke-tested in Task 8.

- [ ] **Step 1:** `scripts/night-cli.js` — subcommands `estimate` (calls quota.estimatePlan), `create` (NightPlan.create), `post <id>` (build a Block Kit message with `night_approve/edit/skip` buttons via a small builder in `src/services/night-brief.js`, post to owner DM). Open DB at `AGENDA_DB_PATH` or the default.
- [ ] **Step 2:** `scripts/ratchet-cli.js` — `propose --json <metrics> --change <t> --target <t>`, `resolve <id> keep|revert`, `list`.
- [ ] **Step 3:** Create `src/services/night-brief.js` `buildNightPlanBlocks(plan)` (pure, add a jest test mirroring `brief.test.js`: asserts Approve/Edit/Skip action_ids + plan id in `value` + budget line rendered).
- [ ] **Step 4:** Run the night-brief test → PASS. Commit.

---

### Task 7: Schedulers + endpoints + env

**Files:** Modify `start-slack-socket.js` (config + three schedulers), `socket.js` (`POST /night/plan`, `POST /night/report`), `.env.example`.

- [ ] **Step 1:** Config keys: `nightPlanTime` (`'22:00'`), `morningReportTime` (`'06:00'`), `ratchetEnabled`, `nightWhitelist` (CSV of kinds that skip confirm).
- [ ] **Step 2:** `scheduleNightPlan` — clone of `scheduleMorningBrief` (Plan B); injects: `"Run your night-planner skill now."` Only if `companionEnabled`.
- [ ] **Step 3:** `scheduleMorningReport` — injects `"Run your morning-reporter skill now."`
- [ ] **Step 4:** `scheduleRatchet` — if `ratchetEnabled`, ~00:30 injects `"Run your ratchet skill now."`
- [ ] **Step 5:** `POST /night/plan` and `POST /night/report` (mirror `POST /pulse`) trigger the injections manually for testing.
- [ ] **Step 6:** `.env.example`:

```bash
# ── Entity Plan E: night cycle ──────────────────────────────
NIGHT_PLAN_TIME=22:00
MORNING_REPORT_TIME=06:00
RATCHET_ENABLED=false
# Job kinds that run at midnight without a confirm (CSV): review,analysis
NIGHT_WHITELIST=
# Nightly token ceiling for the quota estimator
NIGHT_TOKEN_BUDGET=2000000
```

- [ ] **Step 7:** `npm test` → all green. Commit.

---

### Task 8: Home board — Tonight / Jobs / Agenda / Rules + switcher

**Files:** Modify `src/channels/slack/home-tab.js` (extend `buildHomeView` with sections + a view-switcher `actions` row); `socket.js` (`_collectHomeState` reads nightPlan/jobs/agenda; register `home_tab_*` switcher actions that re-publish).

- [ ] **Step 1:** Extend the `home-tab.test.js` suite: given state with a pending night plan + jobs + agenda, assert the Overview shows a "Tonight: N jobs, quota fits" line and that a switcher `actions` block with `home_tab_jobs`, `home_tab_agenda`, `home_tab_tonight`, `home_tab_rules` exists.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Extend `buildHomeView(state)`: add `state.tab` (default `overview`); render the switcher row always; render the selected section (Jobs = recent jobs with status; Agenda = open items with ✅💤▶; Tonight = the pending/approved plan with Approve/Edit/Skip if pending; Rules = directives list, or "Plan A pending" note if absent). Keep owner-gating.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** In `socket.js`, extend `_collectHomeState` to include `nightPlan: this.nightPlan.latest()`, `jobs: this.jobs.recent(10)`, `agenda: this.agenda.listOpen()`. Register the four `home_tab_*` actions: each `ack()`s then re-publishes `buildHomeView({...state, tab})`.
- [ ] **Step 6:** `npm test` → green. Commit + push.

---

### Task 9: Live end-to-end (on the VPS)

- [ ] Trigger `POST /night/plan` → plan DM arrives with Approve/Edit/Skip; SQLite `night_plans` has a pending row.
- [ ] Tap Approve → `jobs` table gains the plan's jobs; Mac runner (Plan D) drains them.
- [ ] Trigger `POST /night/report` → report DM cites artifacts; review drafts carry Post/Discard.
- [ ] Open Home tab → Tonight section shows the approved plan; switch to Jobs → see them; Agenda → tap 💤 works.
- [ ] Enable `RATCHET_ENABLED=true`, trigger the ratchet injection → a `ratchet_log` row appears; next run resolves it.
- [ ] Commit any fixups, `git pull --rebase && git push`.

---

## Self-review notes
- Spec coverage: 22:00 plan + quota + confirm (T1,T2,T4,T5,T7) · overnight batch via Plan D queue (T4 approve) · midnight whitelist (T7 config, honored by the planner skill) · 06:00 grounded report (T5 reporter) · ratchet (T3,T5,T6,T7) · Home board (T8).
- Provider APIs: none new; all reasoning is companion-side. Quota is arithmetic.
- Type consistency: job objects `{kind, repo?, pr?, ref, target}` match Plan D's `jobs.enqueue`; `night_approve` value = plan id → `handleNightAction` → `nightPlan.get`.
