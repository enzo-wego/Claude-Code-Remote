# Stop reporting `done` for a job that only went quiet

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** Do **not** `npm rebuild better-sqlite3` for any
reason. `tests/graph-ingest/integration.test.js` fails on a clean tree (a
channel-filter assertion, unrelated); ignore that one.
**Provider APIs:** none.

## The bug, observed live

Job 9 (`address_comments` on `payments-react-component#458`) was reported
`[runner] job 9 done` while the session had **not** finished: two jest tests it
wrote were failing, `reply.md` was never written, and its last words were *"say
the word and I'll write reply.md once codex reports."* The owner had to drive the
rest by hand in herdr.

`waitDone()` in `runner/herdr-exec.js` waits for herdr `done`, accepting `idle`.
Both mean "the agent stopped talking". Neither means the work landed — an agent
that ends its turn with a question is idle, exactly like one that finished.

The prompt in `runner/prompts.js` already instructs the session to draft its
replies in `reply.md`, and the runner already computes that path. Nothing ever
checks whether it appeared. That file is the completion evidence, free of charge:
no pane-text parsing, no new protocol.

## Task 1 — require the artifact (`runner/enzobot-runner.js`)

In the `address_comments` branch, after the final `herdr.waitDone(...)`, read
`replyPath`. Add to the returned result:

- `reply_written`: true only when the file exists **and** has non-whitespace
  content. A zero-byte `reply.md` is the same failure as no file.
- keep `pane_id` and `tail` exactly as they are.

**Do not throw when it is missing.** A thrown error retries the job, and each
attempt opens another pane — three attempts would leave three live sessions on
the same PR. An honest incomplete result is the correct outcome: the job did run,
the pane is alive, and the owner is the one who can move it forward.

Guard the file read with try/catch — the runner is dependency-free and a
permissions or encoding surprise must not turn a finished job into a failed one.

## Task 2 — say so in Slack (`src/channels/slack/socket.js`)

In the `address_comments` branch of `_onJobResult` (added in `3048b44`), branch on
`result.reply_written`:

- true → keep today's message (`:white_check_mark: Finished addressing comments
  on *repo#N* in pane …` plus the tail).
- false → say the session stopped without writing its reply draft, that the pane
  is still live, and that it may be waiting on the owner. Use
  `:warning:` rather than `:white_check_mark:` — the glyph is the whole point of
  this change, since the old message claimed success either way.

While in there, fix the neighbouring nit: when `result.pane_id` is missing the
text renders ``in pane `undefined` ``. Omit the pane clause when there is no id.

## Task 3 — test both outcomes

In `tests/runner/` (mock `herdr` the way the existing runner tests do): a written
`reply.md` yields `reply_written: true`; a missing one and a whitespace-only one
both yield `false`, and neither throws.

In `tests/channels/pr-wiring.test.js`: a result with `reply_written: false` posts
the warning wording, still in the PR thread; `true` keeps the existing wording; a
result with no `pane_id` contains no "undefined".

## Task 4 — verify

Full suite green but the known `graph-ingest` failure. Commit to `release` with a
message in the repo's voice: subject says what changed for the reader, body says
why. **Do not push.**

## Out of scope — do not build

Changing `waitDone()` itself or herdr's status detection — the fix is evidence at
the call site, not a new notion of doneness. Also out: giving the pane a way to
ask the owner something mid-task (that needs the Mac Stop hook and pane-as-session
rows, a separate design), retry/pane-cleanup policy, and the reply-posting verb.
