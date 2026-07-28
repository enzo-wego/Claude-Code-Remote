# EnzoBot Plan H — Home Task Board (new Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the App Home tab into a shared task board you and EnzoBot co-manage: EnzoBot suggests tasks (from Slack/GitHub/Jira), you accept/reject, and you manually add/edit/status tasks yourself. Human-in-the-loop task validation BEFORE any autonomy.

**Why this is Step 1:** It de-risks everything downstream. Before EnzoBot ever acts unattended (Plans D/E), you confirm on a page that it defines the *right* tasks. If it does, autonomy is trustworthy; if not, you find out cheaply.

**Repository:** `Claude-Code-Remote` (Node.js). Builds directly on the shipped Home tab v0 (`src/channels/slack/home-tab.js`). No companion, no night cycle, no autonomy.

**Provider APIs:** **None.** Collectors are plain HTTP (Slack/GitHub/Jira REST). No LLM call anywhere in this plan.

**Reuses from Plan B (build those tasks first, or inline them here):** the agenda store (`src/services/agenda.js`), the three collectors (`src/collectors/*`), and the aggregator (`scripts/collect.js`). Plan H = Plan B tasks 1, 3, 4, 5, 6 + an interactive Home tab. It does NOT need Plan B's companion/brief/scheduler tasks.

---

## Data model note (extend Plan B's agenda)

The agenda table gains two things vs Plan B:
- `status` values: `proposed | open | in_progress | done | snoozed | dropped`.
- `origin` column: `manual | suggested`.

Suggested tasks land as `status='proposed'` (pending your accept). Accept → `open`. Reject → `dropped`. You can also add `manual` tasks directly as `open`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/services/agenda.js` (from Plan B, extend) | + `origin` column, + `proposed`/`in_progress` statuses, + `listAll(states)` |
| `src/collectors/*` + `scripts/collect.js` (from Plan B) | Produce candidates for "Suggest" |
| `src/channels/slack/home-board.js` (new) | Pure renderer: agenda state → Home Block Kit (rows + buttons + add modal trigger) |
| `src/channels/slack/home-actions.js` (new) | Button/modal handlers: add, edit, status, accept, reject, suggest |
| `src/channels/slack/home-tab.js` (modify) | Call the board renderer for the Agenda section |
| `src/channels/slack/socket.js` (modify) | Register the actions + `view_submission` for the add-task modal; suggest runs collect |
| `.env.example` (modify) | Reuse Plan B's collector creds (GITHUB_TOKEN, JIRA_*, COMPANION_SLACK_CHANNELS) |

---

### Task 1: Extend the agenda store

**Files:** Modify `src/services/agenda.js` (Plan B); Test: extend `tests/services/agenda.test.js`.

- [ ] **Step 1: Add failing tests**

```js
test('origin defaults, proposed→open via accept, →dropped via reject', () => {
  const agenda = createAgenda();
  const s = agenda.upsert({ dedupe_key: 'thread_reply:C:1', kind: 'thread_reply', source_ref: 'x', title: 't', origin: 'suggested', status: 'proposed' });
  expect(agenda.get(s.id).status).toBe('proposed');
  expect(agenda.get(s.id).origin).toBe('suggested');
  agenda.setStatus(s.id, 'open');
  expect(agenda.listByStatus(['open'])).toHaveLength(1);
});
test('listByStatus filters; in_progress supported', () => {
  const agenda = createAgenda();
  const m = agenda.upsert({ dedupe_key: 'manual:1', kind: 'custom', source_ref: '', title: 'Deploy', origin: 'manual', status: 'open' });
  agenda.setStatus(m.id, 'in_progress');
  expect(agenda.listByStatus(['in_progress'])).toHaveLength(1);
  expect(agenda.listByStatus(['proposed'])).toHaveLength(0);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Extend `agenda.js`: add `origin TEXT NOT NULL DEFAULT 'manual'` and allow the new statuses (no CHECK constraint, or widen it). Add `upsert` support for explicit `origin` + `status`. Add `listByStatus(states[])` (parameterized `IN`). Keep `listOpen()` = `listByStatus(['open','in_progress'])` plus due snoozed. Preserve the sticky-done rule (upsert never resurrects a done/dropped item).
- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 2: Board renderer (pure)

**Files:** Create `src/channels/slack/home-board.js`; Test `tests/channels/home-board.test.js`.

- [ ] **Step 1: Failing test**

```js
const { buildBoardBlocks } = require('../../src/channels/slack/home-board');
describe('buildBoardBlocks', () => {
  const tasks = [
    { id: 1, title: 'Review PR #412', status: 'open', origin: 'manual' },
    { id: 2, title: 'Reply to Minh', status: 'proposed', origin: 'suggested' },
    { id: 3, title: 'Deploy tax-service', status: 'in_progress', origin: 'manual' },
  ];
  test('header has Add + Suggest buttons', () => {
    const b = buildBoardBlocks(tasks);
    const ids = JSON.stringify(b);
    expect(ids).toContain('task_add');
    expect(ids).toContain('task_suggest');
  });
  test('proposed task shows accept/reject; open shows start/done/snooze', () => {
    const b = buildBoardBlocks(tasks);
    const s = JSON.stringify(b);
    expect(s).toContain('task_accept'); expect(s).toContain('task_reject');
    expect(s).toContain('task_start'); expect(s).toContain('task_done'); expect(s).toContain('task_snooze');
  });
  test('in_progress task shows a done button and a progress marker', () => {
    const b = buildBoardBlocks(tasks);
    expect(JSON.stringify(b)).toContain('task_done');
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildBoardBlocks(tasks)`:
  - Header `actions` row: `➕ Add task` (`task_add`), `🔄 Suggest tasks` (`task_suggest`).
  - Group by status: In progress → Open → Proposed (suggested, pending) → (done/snoozed collapsed count).
  - Each row: a `section` with a status glyph + title + origin tag, followed by an `actions` row whose buttons depend on status:
    - `proposed`: `✅ Accept` (`task_accept`), `🗑 Reject` (`task_reject`)
    - `open`: `▶ Start` (`task_start`), `✓ Done` (`task_done`), `💤 Snooze` (`task_snooze`)
    - `in_progress`: `✓ Done` (`task_done`), `💤 Snooze` (`task_snooze`)
  - Every button carries `value: String(task.id)`.
- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 3: Action + modal handlers

**Files:** Create `src/channels/slack/home-actions.js`; Test `tests/channels/home-actions.test.js`.

- [ ] **Step 1: Failing test**

```js
const Database = require('better-sqlite3');
const Agenda = require('../../src/services/agenda');
const { handleBoardAction, addTaskModalView, parseAddTaskSubmission } = require('../../src/channels/slack/home-actions');
function setup() {
  const agenda = new Agenda(new Database(':memory:'));
  const p = agenda.upsert({ dedupe_key: 'k1', kind: 'custom', source_ref: '', title: 'T', origin: 'suggested', status: 'proposed' });
  return { agenda, id: p.id };
}
describe('handleBoardAction', () => {
  test('accept moves proposed→open', async () => {
    const { agenda, id } = setup();
    await handleBoardAction({ actionId: 'task_accept', value: String(id), agenda });
    expect(agenda.get(id).status).toBe('open');
  });
  test('reject moves →dropped', async () => {
    const { agenda, id } = setup();
    await handleBoardAction({ actionId: 'task_reject', value: String(id), agenda });
    expect(agenda.get(id).status).toBe('dropped');
  });
  test('start→in_progress, done→done', async () => {
    const { agenda, id } = setup();
    agenda.setStatus(id, 'open');
    await handleBoardAction({ actionId: 'task_start', value: String(id), agenda });
    expect(agenda.get(id).status).toBe('in_progress');
    await handleBoardAction({ actionId: 'task_done', value: String(id), agenda });
    expect(agenda.get(id).status).toBe('done');
  });
});
describe('add-task modal', () => {
  test('modal view has a title input; submission parses it', () => {
    expect(JSON.stringify(addTaskModalView())).toContain('task_title');
    const view = { state: { values: { t: { task_title: { value: 'Write spec' } } } } };
    expect(parseAddTaskSubmission(view)).toBe('Write spec');
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `home-actions.js`:
  - `handleBoardAction({actionId, value, agenda})`: map `task_accept→open`, `task_reject→dropped`, `task_start→in_progress`, `task_done→done`, `task_snooze→snooze 24h`. Return a short confirmation string. Unknown id → friendly error.
  - `addTaskModalView()`: a Block Kit modal (`type: 'modal'`, `callback_id: 'task_add_modal'`) with a `plain_text_input` block id `t`, action `task_title`, and a submit button.
  - `parseAddTaskSubmission(view)`: pull `state.values.t.task_title.value`.
  - `createManualTask(agenda, title)`: `agenda.upsert({ dedupe_key: 'manual:'+Date.now(), kind:'custom', source_ref:'', title, origin:'manual', status:'open' })`.
- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 4: Suggest = run collectors, upsert as proposed

**Files:** `src/channels/slack/home-actions.js` (add `suggestTasks`).

- [ ] **Step 1:** Implement `async suggestTasks(agenda)`: run the collectors (call the Plan B collector functions directly, or shell `scripts/collect.js` and parse JSON). For each candidate, `agenda.upsert({...candidate, origin:'suggested', status:'proposed'})` — the sticky-done rule means already-handled items don't reappear. Return `{added, errors}`.
- [ ] **Step 2:** Test (mock collectors): given two candidates, `suggestTasks` inserts two `proposed` rows; a candidate whose dedupe_key is already `done` is not resurrected.
- [ ] **Step 3:** Commit.

---

### Task 5: Wire into the Home tab + socket

**Files:** Modify `src/channels/slack/home-tab.js`, `src/channels/slack/socket.js`.

- [ ] **Step 1:** In `home-tab.js` `buildHomeView`, replace the placeholder "coming soon" agenda line with the board: `...buildBoardBlocks(state.tasks || [])`. Keep owner-gating (non-owner still gets the minimal card).
- [ ] **Step 2:** In `socket.js` `_collectHomeState`, add `tasks: this.agenda.listByStatus(['in_progress','open','proposed'])`.
- [ ] **Step 3:** Register button actions (loop, like Plan B's agenda buttons): `task_accept, task_reject, task_start, task_done, task_snooze` → `handleBoardAction` → post ephemeral confirm AND re-publish the Home view (`views.publish` with fresh state) so the board updates live.
- [ ] **Step 4:** Register `task_add` → `views.open` with `addTaskModalView()` (needs the button's `trigger_id`). Register `view_submission` for `callback_id === 'task_add_modal'` → `createManualTask` → re-publish Home.
- [ ] **Step 5:** Register `task_suggest` → `suggestTasks(this.agenda)` → post a short "added N suggestions (M source errors)" ephemeral → re-publish Home.
- [ ] **Step 6:** `npm test` → green. Commit.

---

### Task 6: Live verification (VPS)

- [ ] Deploy: `git pull && npm run restart`. Open EnzoBot → Home.
- [ ] Tap **➕ Add task** → modal → submit "Test task" → appears as `open` with Start/Done/Snooze.
- [ ] Tap **▶ Start** → moves to In progress; **✓ Done** → leaves the board (verify `agenda-cli` shows it done).
- [ ] Tap **🔄 Suggest tasks** → proposed rows appear from GitHub/Jira/Slack (needs the read creds in `.env`); tap **✅ Accept** on one → becomes open; **🗑 Reject** another → gone.
- [ ] Confirm non-owner opening the tab sees only the minimal card (no tasks).
- [ ] Commit fixups, `git pull --rebase && git push`.

---

## Self-review notes
- Provider APIs: none. Pure HTTP collectors + SQLite + Block Kit.
- This is the human-in-the-loop validation gate for the whole Entity: you confirm task-definition quality on a page before autonomy (D/E) is trusted.
- Reuse: agenda store + collectors are shared verbatim with Plan B — build Plan B tasks 1,3,4,5,6 first (or as part of H), then H adds only the interactive Home tab. When Plan B's companion/brief later lands, it reads/writes the SAME agenda table, so the board and the brief stay in sync automatically.
- Type consistency: candidate shape (dedupe_key/kind/source_ref/title/evidence) unchanged; `origin` + widened `status` are additive; button `value` = task id everywhere.
