# Let a runner pane speak to Slack, so the owner never has to open herdr

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** Do **not** `npm rebuild better-sqlite3` for any
reason. `tests/graph-ingest/integration.test.js` fails on a clean tree (a
channel-filter assertion, unrelated); ignore that one.
**Provider APIs:** none beyond Slack calls the bot already makes.

## The problem, observed live

On 2026-07-30 job 9 resumed a session, fixed three review threads, then stopped
to ask: *"say the word and I'll write reply.md once codex reports."* Slack heard
nothing, because a runner pane can reach Slack **exactly once** — through its job
result, at the end. The owner had to open herdr and type the answer into the pane
by hand. That is the last manual step in an otherwise automated loop.

Why the existing notification path does not cover it, verified:

- The path is `cli-hook-notify.js`, installed as a Claude `Stop` hook. It looks
  up a **tmux session row in the bot's SQLite** to find the channel and thread.
- That DB lives on the VPS. The runner's panes live on the Mac, are herdr panes
  rather than tmux sessions, and have no row.
- The Mac's `~/.claude/settings.json` `Stop` hook is a memory-sync git commit for
  an unrelated project. There is no `cli-hook-notify.log` on the Mac at all.

So the Mac has no hook, and even with one it would have no local DB to resolve.
The missing piece is an address for the pane to write to — and the per-PR Slack
thread shipped in `007d5ae` is exactly that address.

## What exists already, and must be reused rather than rebuilt

- `_postForPr(task, message)` in `src/channels/slack/socket.js` — resolves the
  PR's thread, creating it on first use. The destination is solved.
- `prTasks.byRepoNumber(repo, number)` — payload to task row.
- `pane_message` job kind — relays text **into** a live pane. The return path
  already exists; do not build a second one.
- The runner HTTP endpoints and their `x-runner-token` check using
  `crypto.timingSafeEqual`, which **fails closed**. Any new endpoint uses the
  same check, the same way.
- `CLI_SOURCE`, exported into the tmux prelude and read back by
  `cli-hook-notify.js` — the precedent for "the launcher tells the session who it
  is via the environment". Task 1 is the same trick.

## Task 1 — the pane knows which job it is (`runner/enzobot-runner.js`)

When launching the CLI in a job pane, prefix the command with
`ENZOBOT_JOB_ID=<job.id>` so the variable is exported into the pane's shell and
inherited by every process the session spawns — including its hooks.

Apply it to the `address_comments` and `apex_review` branches, wherever
`herdr.startAgent(paneId, cli)` is called with a constructed command string.
Nothing else changes about the launch.

## Task 2 — the hook that posts (`runner/pane-notify.js`, new)

A small script, dependency-free like the rest of `runner/`:

1. Read `ENZOBOT_JOB_ID`. **If absent, exit 0 immediately and silently** — this
   hook fires on every Claude session on the Mac, and all but the job panes are
   the owner's ordinary work. This early return is the whole safety story.
2. Read the hook payload from stdin (same shape `cli-hook-notify.js` parses:
   `last_assistant_message`, `transcript_path`, `session_id`).
3. `POST` to the runner API's new `/pane-event` with the `x-runner-token` header
   the runner already uses, body `{ job_id, text, kind: 'stop' }`.
4. Never throw. A failed post logs to `runner/pane-notify.log` and exits 0 —
   a notification failure must not break the owner's session.

Install it by **appending** to `hooks.Stop` in `~/.claude/settings.json`, never
replacing: that slot already holds the memory-sync commit, and clobbering it
would silently stop another project's memory from being saved. Add the install
to `npm run hooks:install` for the Mac, and document that this hook is
Mac-runner-specific.

## Task 3 — the endpoint (`src/channels/slack/socket.js`)

`POST /pane-event`, guarded by the same fail-closed `x-runner-token` check as the
other runner endpoints:

- look up the job by `job_id`, parse `payload_json` for `repo` / `pr`;
- `prTasks.byRepoNumber(...)` → task;
- post through `_postForPr(task, { text })` so it lands in that PR's thread,
  prefixed to make clear it is the session speaking, not the bot
  (e.g. `:speech_balloon: *#458 session:*`);
- no task, or no job → respond 404 and post nothing. Do not invent a
  destination for a message whose PR cannot be identified.

Truncate the text the way `pane_message` results are truncated. Rate-limit is not
needed: a Stop hook fires once per turn.

## Task 4 — answering from Slack

A message listener on the PR thread: a reply in a thread whose `slack_ts` matches
a PR row, from the owner, enqueues `pane_message` against that PR's live pane —
which needs the pane id stored on the task (add `pane_id`, written when an
`address_comments` or `apex_review` result arrives).

Constraints that are not negotiable:
- **owner-only**, matching the guard every PR action already applies;
- respect `APP_MODE` filtering the way `_setupListeners` does, so a `local` and a
  `cloud` instance do not both relay the same reply;
- ignore the bot's own messages, or the thread will talk to itself.

If Task 4 grows beyond this, stop and ship Tasks 1–3 alone: knowing the session
is waiting is most of the value, and the 📤 / ✏️ / 🚪 buttons still work.

## Task 5 — tests, then verify

- `pane-notify` exits 0 and posts nothing when `ENZOBOT_JOB_ID` is unset (the
  safety case, test it first);
- it posts `{job_id, text}` to the endpoint when the variable is set, and still
  exits 0 when the post fails;
- `/pane-event` with a bad token responds 401 and posts nothing; with a good
  token and a known job it posts into the PR thread; with an unknown job it 404s;
- a thread reply from the owner enqueues `pane_message` for the right pane; from
  anyone else, nothing.

Full suite green but the known `graph-ingest` failure. Commit to `release` with a
message in the repo's voice. **Do not push.**

## Out of scope — do not build

Changing `waitDone` (already handled in `508acf2`), any automatic trigger for
Process, resolving GitHub threads from Slack, and giving the VPS write
credentials. The pane keeps doing the writing; Slack stays the place you decide.
