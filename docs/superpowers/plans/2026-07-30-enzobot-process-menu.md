# Process menu on My PRs: one tap resumes the session that built the branch

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** `better-sqlite3@12.6.2` cannot build against
Homebrew Node 26 (V8 14 removed `v8::PropertyCallbackInfo::This()`). Do **not**
`npm rebuild better-sqlite3` to "fix" a `NODE_MODULE_VERSION 127 vs 147` error —
that destroys the working Node 22 binding and leaves no usable one.
The `tests/graph-ingest/integration.test.js` localhost failure is pre-existing on
a clean tree; ignore it. Everything else must be green.
**Provider APIs:** none.

## What exists already, and must be reused rather than rebuilt

- `overflow(taskId, entries)` in `src/channels/slack/pr-board.js` — builds the
  `pr_menu` overflow the team lane already uses. Supports a per-option `url`.
- `handlePrAction({actionId, value, prTasks, jobs})` in
  `src/channels/slack/pr-actions.js` — a switch on `actionId`, value encoded as
  `actionId:taskId`. **`pr_dismiss` already works and is lane-agnostic.
  `pr_open` needs no case at all** — Slack opens the option's `url` client-side.
- `AgentSessions` in `src/services/agent-sessions.js` — `sessionsFor(prId)`
  returns sessions attached to the PR *and* to its ticket, most-recently-used
  first. Wired as `this.agentSessions` in `socket.js` `_initDb`.
- `runner/herdr-exec.js` — `ensureWorkspace`, `createJobPane`, `startAgent`,
  `submitTask`, `waitDone`, `readTail`, `closePane`.
- `runner/enzobot-runner.js` — `executeJob` switch on `job.kind`, with
  `apex_review` as the closest model to copy.
- `job-results.js` / `pane_message` / `pane_close` — the existing
  📤 Post / ✏️ Edit / 🚪 Exit relay against a live pane. **Do not reimplement it.**

## Task 1 — the menu

In `mineLaneBlocks`, replace the `linkButton('🔗 Open', task.url)` accessory with
`overflow(task.id, ...)` carrying exactly three entries:

| Text | actionId | Notes |
|---|---|---|
| `⚙️ Process` | `pr_process` | new, task 2 |
| `🗑 Dismiss` | `pr_dismiss` | handler exists |
| `🔗 Open on GitHub` | `pr_open` | pass `url: task.url` |

**Leave the 🚀 Merge branch exactly as it is.** A section takes one accessory, so
on an approved + green PR Merge keeps the row — it carries a confirm dialog that
an overflow cannot express per option, and merging is the decision that matters
at that point. Do not move Merge into the menu, and do not drop its confirm.

Tests in `tests/channels/pr-board.test.js`: a non-mergeable `mine` row exposes
`pr_menu` with those three values in that order; a mergeable row still exposes
`pr_merge` with its confirm and no overflow.

## Task 2 — `pr_process`

New case in `handlePrAction`. It needs `agentSessions` passed in — thread it
through the same way `prTasks` and `jobs` are, and update every call site.

```
const sessions = agentSessions ? agentSessions.sessionsFor(task.id) : [];
sessions.length === 0  → enqueue with sessionKey: null   (fresh session, no compact)
sessions.length === 1  → enqueue with that session's key + cli
sessions.length  >  1  → do NOT enqueue: return a picker
```

Dedupe key `address_comments:${task.repo}#${task.number}` so a double tap does
not open two panes. On a deduped enqueue return an
`:information_source:` telling the owner it is already queued, matching
`pr_review_now`'s wording.

**The 2+ case must not guess.** The job runs `/compact`, which is irreversible —
resuming the wrong conversation destroys context that does not come back. Return
Block Kit with one button per candidate, `action_id: 'pr_process_with'`, value
`${task.id}:${session.id}`, labelled with the session's `label` (falling back to
a short prefix of its `key`) and how long ago it was last used. Add the matching
`pr_process_with` case, which enqueues for exactly the chosen session and calls
`agentSessions.touch(sessionId)`.

`touch()` on the resolved session in the 1-session path too — the ordering only
means something if resumes are recorded.

Job payload: `{ repo, pr, url, title, sessionKey, cli, threads: null }`.

## Task 3 — `address_comments` in the runner

New `job.kind === 'address_comments'` branch in `executeJob`, modelled on
`apex_review`:

1. `repoPath(config, payload.repo)` for the cwd — it already throws a clear error
   when the repo is missing from `repoMap`.
2. `ensureWorkspace()` + `createJobPane({ label: jobLabel(...), cwd })`.
3. `startAgent(paneId, cli)` where `cli` is
   `` `${config.cliCommand} --resume ${payload.sessionKey}` `` when a key is
   present, else `config.cliCommand` unchanged.
4. **When resuming, compact first:** `submitTask(paneId, '/compact')` then
   `waitDone(paneId, config.jobTimeoutMs)`. It must go through `submitTask`, not
   a bare `herdr pane run` — a slash command opens the TUI's command palette,
   which swallows the Enter that `pane run` sends. `submitTask`'s existing
   3-attempt Enter loop is what makes it land. Verified by hand 2026-07-30.
   Skip this step entirely when there is no session to resume; there is nothing
   to compact and a fresh session would waste a turn.
5. Write the prompt to `<jobsDir>/<id>/prompt.md` and
   `submitTask(paneId, 'Read <path> and follow it exactly.')`.
6. `waitDone`, then return `{ pane_id: paneId, tail: <last ~40 lines> }` so the
   existing relay can talk to the pane.

**The prompt must make the session fetch its own threads**, not read them from
the payload. Include the exact query to run:

```
gh api graphql -f query='
{ repository(owner:"OWNER", name:"NAME") {
    pullRequest(number:N) {
      reviewThreads(first:100) { nodes {
        isResolved isOutdated path line
        comments(last:10) { nodes { author { login } body createdAt url } } } } } } }'
```

and tell it: a thread is waiting on you only when `isResolved` and `isOutdated`
are both false **and** the last comment's author is not you. Three reasons for
fetching in-session rather than in the payload — no duplicated GraphQL in the
dependency-free runner, the threads are current at execution time instead of
enqueue time, and the session already has the owner's `gh` auth.

The prompt must also state, in its own words: **do not post to GitHub and do not
push.** Verify, fix, write a reply draft to a file, and report. The owner posts
via the existing relay buttons.

Tests in `tests/runner/` (mock `herdr` the way the existing runner tests do):
`--resume <key>` reaches `startAgent` when a key is present and is absent when it
is not; `/compact` is submitted through `submitTask` exactly once when resuming
and never when starting fresh; the prompt file contains the owner's repo and PR
number; the result carries `pane_id`.

## Task 4 — verify

Full suite green but the known graph-ingest failure. Commit to `release` with a
message in the repo's voice: subject says what changed for the reader, body says
why. **Do not push.**

## Out of scope — do not build

Any automatic trigger. Process is a tap the owner takes, deliberately: manual is
the default. Do not extend `PR_AUTO_REVIEW`, do not add a `changes_requested`
watcher, do not enqueue from a sweep. Also out: resolving threads from Slack, and
moving Merge into the overflow.
