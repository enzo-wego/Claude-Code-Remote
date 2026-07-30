# Tell Slack when an `address_comments` job finishes

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** Do **not** `npm rebuild better-sqlite3` for any
reason; it cannot build against Homebrew Node 26 and the rebuild destroys the
working Node 22 binding. `tests/graph-ingest/integration.test.js` fails on a
clean tree (a channel-filter assertion, unrelated); ignore that one.
**Provider APIs:** none.

## The bug, observed live

Tapping ⚙️ Process enqueues an `address_comments` job. The job ran end to end on
2026-07-30 — resumed the right session, compacted, fetched its four unresolved
review threads, fixed three of them — and Slack said **nothing**. `grep -n
address_comments src/channels/slack/socket.js` returns no match: `_onJobResult`
handles `review`, `apex_review`, `merge_pr`, `pane_message` and `pane_close`, and
falls off the end for everything else.

So the owner sees `⚙️ Processing #458 on your Mac…` and then silence, however
well the job goes. The only way to learn the outcome is to read the pane.

(`_onJobFailed` is already generic and does report these, so this is the success
path only.)

## Task 1 — the missing branch

In `_onJobResult` in `src/channels/slack/socket.js`, add an
`else if (job.kind === 'address_comments')` branch. The result written by
`runner/enzobot-runner.js` is `{ pane_id, tail }`, and the payload carries
`repo` / `pr` / `url` / `title`.

Model it on the `pane_message` branch immediately above it, which already does
exactly the right lookup-and-post shape:

- resolve the task with `this.prTasks.byRepoNumber(payload.repo, payload.pr)`;
- post through `this._postForPr(task, message)` when it resolves, so the message
  lands in that PR's thread, and through the local `postFlat` helper when it does
  not — same fallback every other branch uses;
- text: say which PR finished and include the tail in a fenced block, truncated
  the way `pane_message` truncates it (`result.tail.slice(-1000)`);
- name the live pane in the message (`result.pane_id`) — the session is still
  open and that id is how the owner finds it;
- `await this._publishHome(this.config.ownerUserId)` at the end, like the
  branches around it.

**Do not render the 📤 Post / ✏️ Edit / 🚪 Exit buttons, and do not link the job
as the task's draft job.** Those three actions send a `pane_message` telling the
session to *"post the review to GitHub as a COMMENT"* — the wrong verb here. An
`address_comments` run has drafted replies to individual review threads, not a
review; wiring the existing buttons up to it would put a button on screen that
issues an instruction the session was never asked to carry out. Getting the right
verb is a separate change (see below). Until then the message reports and the
owner drives the pane directly.

## Task 2 — test it

In `tests/channels/pr-wiring.test.js`, beside the threading tests added in
`007d5ae`. The harness is already set up for this: `postMessage` returns a `ts`
and `chat.getPermalink` is mocked.

- a completed `address_comments` job for a known PR posts into that PR's thread
  (`thread_ts` set), with text containing the repo#number, the pane id, and the
  tail;
- the same job for a PR with no row is still delivered, flat, with no
  `thread_ts`;
- `_publishHome` was called.

## Task 3 — verify

Full suite green but the known `graph-ingest` failure. Commit to `release` with a
message in the repo's voice: subject says what changed for the reader, body says
why. **Do not push.**

## Out of scope — do not build

The reply-posting verb (a `pr_reply` action telling the session to post its
drafted replies to the review threads it addressed, and to resolve them) — that
needs a decision about whether resolving threads from Slack is wanted at all.
Also out: changing what the runner returns, touching `waitDone`'s
completion detection, and any automatic trigger for Process.
