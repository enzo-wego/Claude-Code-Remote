# EnzoBot Plan H — PR Review Board (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Manage PR reviews from the Home tab. EnzoBot detects PRs that need your review, monitors them, and on demand runs `/apex-review` on your Mac to produce a draft review you post with one tap.

**Repository:** `Claude-Code-Remote` (Node.js) for the board/detection/monitor; the Mac runner directory for the apex-review job. Reuses Plan D's jobs queue + runner (build that slice first).

**Provider APIs:** **None in our code.** PR detection/monitoring is plain GitHub REST + Slack. The review itself is `/apex-review` = Claude Code running in a herdr pane (Anthropic via Claude Code auth, no key).

**Autonomy (locked with owner):** apex-review NEVER auto-posts. EnzoBot drafts; you tap **📤 Post** (posts as you, via your Mac's `gh`). Reversible-only autonomy: detection, monitoring, and drafting are automatic; posting is your tap.

## The three stages

- **S1 — detect:** a Slack message containing a GitHub PR URL, OR GitHub `review-requested:@me`, becomes a **PR task** on the board. EnzoBot auto-picks PRs where your review is requested or you're a code-owner.
- **S2 — monitor:** each PR task tracks CI status, new commits, and review state; the board reflects live state and nudges when a PR is review-ready (CI green + review still requested).
- **S3 — review:** "Review now" (manual button, or auto when review is requested + CI green) enqueues an `apex_review` job → Mac herdr runs `/apex-review` → the ranked findings become a draft review → DM + Home with **📤 Post / ✏️ Edit / 🗑 Discard**.

---

## Depends on
- **Plan D slice** (jobs queue + Mac runner + herdr wrapper): Tasks 1, 2, 6, 7, 8 of `2026-07-23-enzobot-plan-d-mac-runner.md`. Build those first — the `apex_review` job kind is added here.
- **Plan B slice** (GitHub collector): reuse `src/collectors/github-prs.js` for the review-requested sweep.

## File structure

| File | Responsibility |
|---|---|
| `src/services/pr-tasks.js` (new) | `pr_tasks` table: repo, number, url, ci, review_state, status, origin |
| `src/services/pr-detect.js` (new) | Parse PR URLs from Slack text; decide "needs my review" |
| `src/services/pr-monitor.js` (new) | Poll GitHub for CI + review state; compute review-ready |
| `runner/prompts.js` (Plan D, extend) | `buildApexReviewPrompt` (invoke `/apex-review`, write result file) |
| `runner/enzobot-runner.js` (Plan D, extend) | Handle `apex_review` job kind |
| `src/channels/slack/pr-board.js` (new) | Pure renderer: PR tasks → Home Block Kit rows + buttons |
| `src/channels/slack/pr-actions.js` (new) | Buttons: review-now, post, edit, discard, dismiss |
| `src/channels/slack/home-tab.js` (modify) | Render the PR board section |
| `src/channels/slack/socket.js` (modify) | Detect PRs in message listener; register actions; monitor loop |
| `.env.example` (modify) | `PR_BOARD_ENABLED`, `GITHUB_TOKEN`, `PR_MONITOR_INTERVAL_MIN`, `PR_AUTO_REVIEW` |

---

### Task 1: PR-task store

**Files:** Create `src/services/pr-tasks.js`; Test `tests/services/pr-tasks.test.js`; wire `this.prTasks = new PrTasks(this.db)` in `_initDb`.

- [ ] **Step 1: Failing test**

```js
const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const create = () => new PrTasks(new Database(':memory:'));
describe('PrTasks', () => {
  test('upsert dedupes by repo#number; updates ci/review state', () => {
    const p = create();
    const a = p.upsert({ repo: 'wego/payments', number: 412, url: 'u', origin: 'slack' });
    const b = p.upsert({ repo: 'wego/payments', number: 412, url: 'u', ci: 'green', reviewState: 'requested' });
    expect(b.id).toBe(a.id);
    expect(p.get(a.id).ci).toBe('green');
  });
  test('reviewReady = ci green AND review requested AND status active', () => {
    const p = create();
    const t = p.upsert({ repo: 'r', number: 1, url: 'u', ci: 'green', reviewState: 'requested' });
    expect(p.reviewReady()).toHaveLength(1);
    p.setStatus(t.id, 'posted');
    expect(p.reviewReady()).toHaveLength(0);
  });
  test('setStatus transitions; listActive excludes done/dismissed', () => {
    const p = create();
    const t = p.upsert({ repo: 'r', number: 2, url: 'u' });
    p.setStatus(t.id, 'reviewing');
    expect(p.listActive()).toHaveLength(1);
    p.setStatus(t.id, 'dismissed');
    expect(p.listActive()).toHaveLength(0);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/services/pr-tasks.js`

```js
/**
 * pr_tasks — PRs EnzoBot is tracking for review. status flow:
 *   detected → needs_review → reviewing → drafted → posted | dismissed
 * origin: slack | github-sweep. reviewReady() drives S2 nudges + S3 auto.
 */
class PrTasks {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS pr_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
      title TEXT, author TEXT,
      ci TEXT DEFAULT 'unknown', review_state TEXT DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'detected', origin TEXT DEFAULT 'slack',
      draft_job_id INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(repo, number))`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_tasks(status)');
    this._s = {
      insert: db.prepare(`INSERT INTO pr_tasks (repo,number,url,title,author,ci,review_state,origin,created_at,updated_at)
        VALUES (@repo,@number,@url,@title,@author,@ci,@review_state,@origin,@now,@now)
        ON CONFLICT(repo,number) DO UPDATE SET
          url=excluded.url,
          title=COALESCE(excluded.title,pr_tasks.title),
          author=COALESCE(excluded.author,pr_tasks.author),
          ci=CASE WHEN excluded.ci!='unknown' THEN excluded.ci ELSE pr_tasks.ci END,
          review_state=CASE WHEN excluded.review_state!='unknown' THEN excluded.review_state ELSE pr_tasks.review_state END,
          updated_at=@now`),
      byKey: db.prepare('SELECT * FROM pr_tasks WHERE repo=? AND number=?'),
      get: db.prepare('SELECT * FROM pr_tasks WHERE id=?'),
      listActive: db.prepare("SELECT * FROM pr_tasks WHERE status NOT IN ('posted','dismissed') ORDER BY updated_at DESC"),
      reviewReady: db.prepare("SELECT * FROM pr_tasks WHERE ci='green' AND review_state='requested' AND status IN ('detected','needs_review')"),
      setStatus: db.prepare('UPDATE pr_tasks SET status=?, updated_at=? WHERE id=?'),
      setDraftJob: db.prepare('UPDATE pr_tasks SET draft_job_id=?, status=?, updated_at=? WHERE id=?'),
    };
  }
  upsert(t) {
    this._s.insert.run({ repo: t.repo, number: t.number, url: t.url, title: t.title||null,
      author: t.author||null, ci: t.ci||'unknown', review_state: t.reviewState||'unknown',
      origin: t.origin||'slack', now: Date.now() });
    return this._s.byKey.get(t.repo, t.number);
  }
  get(id){ return this._s.get.get(id); }
  listActive(){ return this._s.listActive.all(); }
  reviewReady(){ return this._s.reviewReady.all(); }
  setStatus(id,s){ this._s.setStatus.run(s, Date.now(), id); }
  setDraftJob(id, jobId){ this._s.setDraftJob.run(jobId, 'reviewing', Date.now(), id); }
}
module.exports = PrTasks;
```

- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 2: PR detection (S1)

**Files:** Create `src/services/pr-detect.js`; Test `tests/services/pr-detect.test.js`.

- [ ] **Step 1: Failing test**

```js
const { extractPrUrls, needsMyReview } = require('../../src/services/pr-detect');
describe('pr-detect', () => {
  test('extracts github PR urls from slack text (angle-bracketed too)', () => {
    const t = 'pls review <https://github.com/wego/payments/pull/412> and https://github.com/wego/tax/pull/7';
    expect(extractPrUrls(t)).toEqual([
      { repo: 'wego/payments', number: 412, url: 'https://github.com/wego/payments/pull/412' },
      { repo: 'wego/tax', number: 7, url: 'https://github.com/wego/tax/pull/7' },
    ]);
  });
  test('needsMyReview: true when review requested from me OR I am code-owner', () => {
    expect(needsMyReview({ requestedReviewers: ['enzo'], me: 'enzo' })).toBe(true);
    expect(needsMyReview({ requestedReviewers: ['bob'], me: 'enzo', codeowner: true })).toBe(true);
    expect(needsMyReview({ requestedReviewers: ['bob'], me: 'enzo' })).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement:
  - `extractPrUrls(text)`: regex `github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)`, strip Slack `<...>`, dedupe.
  - `needsMyReview({requestedReviewers, me, codeowner})`: `requestedReviewers.includes(me) || !!codeowner`.
- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 3: PR monitor (S2)

**Files:** Create `src/services/pr-monitor.js`; Test `tests/services/pr-monitor.test.js` (mock fetch).

- [ ] **Step 1:** Implement `fetchPrState({repo, number, token})` → `{ci: green|red|pending, reviewState: requested|reviewed|none, title, author, requestedReviewers[]}` from GitHub REST (`/repos/{repo}/pulls/{n}` + `/commits/{sha}/check-runs` or `/status`). Pure mapping function `mapCiState(checks)` is unit-tested; the fetch wrapper is thin.
- [ ] **Step 2:** Implement `refreshAll(prTasks, token)`: for each active PR task, fetch state, `prTasks.upsert(...)` with new ci/review_state. Returns the list that newly became `reviewReady`.
- [ ] **Step 3:** Test `mapCiState`: all-success→green, any-failure→red, any-pending→pending. Test `refreshAll` with a mocked fetch flips a task to green.
- [ ] **Step 4:** Commit.

---

### Task 4: apex-review job (S3, Mac side)

**Files:** Extend `runner/prompts.js` + `runner/enzobot-runner.js` (Plan D).

- [ ] **Step 1:** `buildApexReviewPrompt(payload, resultPath)`:

```js
function buildApexReviewPrompt(payload, resultPath) {
  return [
    `Review pull request ${payload.repo}#${payload.pr} (${payload.url}).`,
    `Run the /apex-review skill on it. It reviews in an isolated worktree and never posts.`,
    `From apex-review's findings, keep only must-fix + high-confidence items.`,
    `Write the final review as GitHub-flavored markdown to: ${resultPath}`,
    `(verdict line, then ## Blocking / ## Suggestions / ## Nits — omit empty sections).`,
    `Write a one-line summary (counts) to ${resultPath}.summary. Then print RESULT_READY.`,
    `Do NOT post anything to GitHub. Draft only.`,
  ].join('\n');
}
```

- [ ] **Step 2:** In `enzobot-runner.js` `executeJob`, add `job.kind === 'apex_review'` handling: same shape as the `review` kind (spawn herdr pane in the repo, submit the apex prompt, wait, read `result.md` + `.summary`). Returns `{body_md, summary}`.
- [ ] **Step 3:** Reuse the existing `post_review` job kind for posting (Plan D Task 3/7) — the 📤 button enqueues it, posting via the Mac's `gh`.
- [ ] **Step 4:** Commit.

---

### Task 5: Board renderer + actions

**Files:** Create `src/channels/slack/pr-board.js`, `src/channels/slack/pr-actions.js`; Tests for both.

- [ ] **Step 1: Renderer test** — `buildPrBoardBlocks(prTasks)` shows, per PR: title/repo#num, CI glyph (🟢/🔴/🟡), review state, status; and buttons by status:
  - `detected`/`needs_review`: `🔍 Review now` (`pr_review_now`), `🙈 Dismiss` (`pr_dismiss`)
  - `reviewing`: a "reviewing on your Mac…" note (no button)
  - `drafted`: `📤 Post` (`pr_post`), `✏️ Edit` (`pr_edit`), `🗑 Discard` (`pr_discard`)
  - Every button `value: String(prTask.id)`.
- [ ] **Step 2:** Run → FAIL → implement → PASS.
- [ ] **Step 3: Actions test** — `handlePrAction({actionId, value, prTasks, jobs})`:
  - `pr_review_now`: enqueue `apex_review` job (payload {repo, number→pr, url}); `prTasks.setDraftJob(id, jobId)` (→ status reviewing). Return "Reviewing #N on your Mac…".
  - `pr_post`: enqueue `post_review` job from the draft (dedupe `post_review:repo#n`); set status `posted`. 
  - `pr_discard`: status `dismissed`. `pr_dismiss`: status `dismissed`.
- [ ] **Step 4:** Implement → PASS. Commit.

---

### Task 6: Wire detection + monitor + board into socket.js

**Files:** Modify `src/channels/slack/socket.js`, `home-tab.js`, `start-slack-socket.js`, `.env.example`.

- [ ] **Step 1:** In the `message` listener, if `PR_BOARD_ENABLED`, run `extractPrUrls(event.text)`; for each, fetch PR state, and if `needsMyReview`, `prTasks.upsert({...state, origin:'slack'})`. Fire-and-forget; never block the listener.
- [ ] **Step 2:** In `home-tab.js`, render `buildPrBoardBlocks(state.prTasks)` as the top Home section; `_collectHomeState` adds `prTasks: this.prTasks.listActive()`.
- [ ] **Step 3:** Register `pr_review_now / pr_post / pr_edit / pr_discard / pr_dismiss` actions (loop) → `handlePrAction` → re-publish Home. `pr_edit` posts a note "reply here to tweak, then Post".
- [ ] **Step 4:** When an `apex_review` job completes (Plan D's `_onJobResult`), set the PR task to `drafted` and store the draft; DM the draft with 📤/✏️/🗑 and re-publish Home. When a `post_review` job completes, DM the posted URL.
- [ ] **Step 5:** Monitor loop in `start-slack-socket.js`: `setInterval` every `PR_MONITOR_INTERVAL_MIN` → `pr-monitor.refreshAll(handler.prTasks, GITHUB_TOKEN)`; for each newly review-ready PR, DM a nudge; if `PR_AUTO_REVIEW=true`, auto-enqueue the `apex_review` job.
- [ ] **Step 6:** `.env.example`:

```bash
# ── Entity Plan H: PR review board ──────────────────────────
PR_BOARD_ENABLED=false
GITHUB_TOKEN=
PR_MONITOR_INTERVAL_MIN=15
# Auto-run apex-review when a tracked PR becomes review-ready (still draft-only; you tap Post)
PR_AUTO_REVIEW=false
```

- [ ] **Step 7:** `npm test` → green. Commit + push.

---

### Task 7: Live end-to-end (VPS + Mac)

- [ ] Post a message in a watched channel with a real PR URL where your review is requested → a PR row appears on Home (CI + review state shown).
- [ ] Wait for the monitor to flip CI → green → nudge DM ("#N is review-ready").
- [ ] Tap **🔍 Review now** → Mac herdr spawns a pane running `/apex-review` (watch it) → draft DM arrives with 📤/✏️/🗑; Home shows `drafted`.
- [ ] Tap **📤 Post** → review posted on the PR as you; Home shows `posted`; confirmation DM with the review URL.
- [ ] Set `PR_AUTO_REVIEW=true` → a newly review-ready PR auto-produces a draft without the Review-now tap (posting still your tap).

---

## Self-review notes
- Provider APIs: none new. apex-review = Claude Code in herdr (subscription auth). Monitoring/detection = GitHub REST.
- Leash intact: detection/monitor/draft automatic; the only outward action (posting) is your tap via the Mac's gh. apex-review's never-auto-post design is respected.
- Reuse: jobs queue + runner + post_review from Plan D; github collector from Plan B. This plan adds the `apex_review` job kind, the `pr_tasks` store, detection/monitor, and the PR board UI.
- When the companion/brief (Plan B) and night cycle (Plan E) land, they read the same `pr_tasks`/agenda — the board, brief, and night batch stay consistent.
