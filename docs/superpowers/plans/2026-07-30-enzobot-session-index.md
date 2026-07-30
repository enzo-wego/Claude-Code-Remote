# Work → session index (Phase 1) + resume-and-compact (Phases 2–3)

**Repo:** `Claude-Code-Remote` (this one, Node.js CommonJS, 4-space indent).
**Branch:** `release` (repo convention — commit here, no feature branch).
**Provider APIs:** none. No new dependencies.
**Test:** `npx jest tests/services/agent-sessions.test.js`

> **Scope of this handoff: Phase 1 only.** Phases 2 and 3 are recorded for
> context so Phase 1's shape makes sense; do not build them.

## Why this exists

When a reviewer requests changes on Enzo's own PR, EnzoBot should open a pane on
the Mac and resume *the session that built the feature*. That session was opened
against the **ticket**, days before the PR row existed, so neither
`claude --continue` (newest in the checkout — usually unrelated work) nor a PR-id
lookup can find it. And the pane's first action is `/compact`, which is
**irreversible**: resuming the wrong session destroys context that does not come
back. Hence an explicit index, and an explicit question to the owner whenever
more than one session matches.

## Already on disk (starting point, not finished work)

- `src/services/agent-sessions.js` — written, ~190 lines, **untested**. Treat it
  as a draft: verify it against the schema and behaviours below, fix what is
  wrong, keep what is right.
- `src/services/pr-tasks.js` — `issue_id` column via the existing `_addColumn`
  migration helper, `setIssue(id, issueId)`, and the `setIssue` prepared
  statement. Believed complete.
- `npm rebuild better-sqlite3` has been run on this Mac (fixes the
  `NODE_MODULE_VERSION 127 vs 147` failures that used to break every
  `new Database()` test).

## Schema

`pr_tasks` is already the PR table (`UNIQUE(repo, number)`, stable ids, rows are
never deleted — only status-changed). **Do not create a second PRs table**; it
would need syncing with `pr_tasks` forever. It gains one nullable column.

```
issues (jira | gh_issue) ──< pr_tasks.issue_id
       └──< agent_sessions >──┘        (either side nullable, at least one required)
```

```sql
CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,              -- 'jira' | 'gh_issue'
    key TEXT NOT NULL,               -- 'PAY-2266' | 'wego/payments#12'
    url TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(type, key)
);

CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,               -- resume handle (Claude session uuid)
    cli TEXT NOT NULL DEFAULT 'claude',
    pr_id INTEGER,                   -- → pr_tasks.id
    issue_id INTEGER,                -- → issues.id
    repo TEXT,                       -- checkout for a ticket-only session
    label TEXT,                      -- shown in the picker
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE(cli, key),
    CHECK (pr_id IS NOT NULL OR issue_id IS NOT NULL)
);
CREATE INDEX idx_sessions_pr ON agent_sessions(pr_id);
CREATE INDEX idx_sessions_issue ON agent_sessions(issue_id);
```

Why each column beyond the minimum: `issues.key` is the handle a human attaches
by, and `[PAY-2266]` in PR titles makes auto-linking possible later. `cli`
because this repo runs Codex and Gemini too and they resume differently. `repo`
because a ticket-only session has no PR row to get its checkout from. `label`
because the picker needs something readable.

Table creation follows the repo idiom: `CREATE TABLE IF NOT EXISTS` in the store
class constructor, prepared statements cached on `this._s`. See
`src/services/pr-tasks.js` for the pattern to copy.

## Store API — `src/services/agent-sessions.js`

| Method | Behaviour |
|---|---|
| `upsertIssue({key, type?, url?, title?})` | Idempotent on `(type, key)`. Derives `type` and `url` from the key shape when not given. Throws on an unrecognized key rather than storing it untyped. `COALESCE` so a later call without a title does not blank the stored one. |
| `issue(id)` / `issueByKey(key, type?)` / `listIssues()` | Reads. |
| `add({key, cli?, prId?, issueId?, repo?, label?})` | Upsert on `(cli, key)` — re-linking the same session updates it, never duplicates. `COALESCE` on update so gaining a `pr_id` does not drop the `issue_id`. Throws without a key, and throws when both `prId` and `issueId` are null. |
| `sessionsFor(prId)` | **The load-bearing query.** Sessions attached to the PR **plus** sessions attached to that PR's issue, ordered `COALESCE(last_used_at, created_at) DESC`. 0 → caller starts fresh; 1 → resume it; 2+ → caller asks the owner. |
| `sessionsForIssue(issueId)` | Same ordering, ticket only. |
| `get(id)` / `touch(id)` / `remove(id)` | `touch` stamps `last_used_at`, called when a session is actually resumed so the ordering reflects use. |

Exported helpers: `issueType(key)` → `'jira' | 'gh_issue' | null`
(`/^[A-Z][A-Z0-9]+-\d+$/` vs `owner/repo#123`), and `issueUrl(key, {jiraBase})`
defaulting `jiraBase` to `process.env.JIRA_BASE_URL || 'https://wego.atlassian.net'`.

## Tasks

### 1. Tests first — `tests/services/agent-sessions.test.js`

Build the fixture from a real `PrTasks` on the same `:memory:` handle, because
`sessionsFor` joins across both tables:

```js
const db = new Database(':memory:');
const prTasks = new PrTasks(db);
const sessions = new AgentSessions(db);
```

Cases that must be covered (each one guards a specific way this breaks):

1. `issueType` / `issueUrl` for a Jira key, a GH issue ref, and nonsense.
2. An unrecognized key is refused by `upsertIssue`, not stored untyped.
3. `upsertIssue` twice → one row, same id, title survives the second call.
4. **A session attached only to the ticket is returned by `sessionsFor(prId)`**
   once `prTasks.setIssue(taskId, issue.id)` links them. This is the case the
   whole design exists for.
5. PR-attached and ticket-attached sessions both surface, most-recently-*used*
   first — `touch()` an older session and assert it sorts above a newer one.
6. Re-linking the same `key` with a `prId` keeps the existing `issue_id` and
   does not create a second row.
7. A PR with **no** linked ticket does not see sessions from someone else's
   ticket (guards a join that accidentally matches `NULL = NULL`).
8. `add()` throws without a key, and throws when attached to neither.

Run: `npx jest tests/services/agent-sessions.test.js`. Fix the draft store until
green — do not weaken a test to make it pass.

### 2. Wire it into the service

`src/channels/slack/socket.js`, in `_initDb` (~line 453, next to
`this.prTasks = new PrTasks(this.db);`):

```js
this.agentSessions = new AgentSessions(this.db);
```

plus the `require` at the top of the file with the other service requires.
Nothing reads it yet — this only makes the tables exist on the live DB at
startup. Keep it to those two lines.

### 3. `scripts/session-cli.js`

Copy the shape of `scripts/jobs-cli.js` exactly: `#!/usr/bin/env node`,
`JOBS_DB_PATH`-style env override falling back to
`path.join(__dirname, '../src/data/slack-sessions.db')`, a `switch` on
`process.argv`, JSON to stdout, usage line + `exit(1)` on an unknown command.

```
session-cli link --key <uuid> [--cli claude] [--pr wego/payments-react-component#458]
                 [--issue PAY-2266] [--issue-url <url>] [--issue-title <t>]
                 [--repo wego/payments-react-component] [--label "feature dev"]
session-cli list [--pr wego/x#458] [--issue PAY-2266]
session-cli issues
```

`link` behaviour:
- `--pr owner/repo#number` resolves through `pr_tasks` by `(repo, number)`. If
  no such row exists, **fail with a clear message** — do not invent a PR row;
  the board's sweeps own that table.
- `--issue` upserts the issue (type and url derived) and, when `--pr` was also
  given, calls `prTasks.setIssue(task.id, issue.id)` so the link is durable.
- `--repo` defaults to the PR's repo when a PR was given.
- Print the resulting session row as JSON.

### 4. Verify

```bash
npx jest tests/services/agent-sessions.test.js       # all green
node -e "require('./src/services/agent-sessions')"    # loads clean
node scripts/session-cli.js issues                    # empty array, exit 0
node scripts/session-cli.js link --key test-uuid --issue PAY-2266 --label probe
node scripts/session-cli.js list --issue PAY-2266     # shows the row
```

Then commit to `release` in the repo's voice: a subject line that says what
changed for the reader, not the mechanics, and a body explaining *why* the index
exists (the irreversibility of `/compact` on a wrongly-chosen session). Do not
push; Enzo pushes.

## Out of scope for this handoff

**Phase 2 — resume then compact.** New `address_comments` job kind in
`runner/enzobot-runner.js` beside `apex_review`: `ensureWorkspace()` →
`createJobPane({cwd: repoMap[repo]})` → `startAgent(paneId, 'claude --resume <key>')`
→ `submitTask('/compact')` + `waitDone` → comments fetched on the Mac with the
owner's own `gh`, written to `prompt.md`, submitted as a one-line pointer. Pane
stays open; the existing `pane_message` / `pane_close` relay handles follow-ups.
Zero candidates → fresh session, no compact.

**Phase 3 — the auto trigger.** `changes_requested` only. `pr-monitor` already
computes `review_decision` each sweep; add a `notified_decision` column so one
flip fires one job rather than one per poll. When `sessionsFor()` returns 2+, DM
a picker and enqueue on the owner's tap. A `🔧 Address` button on My PRs rows is
the manual path.

**Deferred entirely:** recording session keys automatically. The `SessionStart`
hook knows the session id and could self-register against the ticket in the
branch name. Phase 1 is populated by hand via the CLI.
