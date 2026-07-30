# One Slack thread per PR, and a menu entry that jumps to it

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** `better-sqlite3@12.6.2` cannot build against
Homebrew Node 26 (V8 14 removed `v8::PropertyCallbackInfo::This()`). Do **not**
`npm rebuild better-sqlite3` to "fix" a `NODE_MODULE_VERSION 127 vs 147` error —
that destroys the working Node 22 binding and leaves no usable one.
`tests/graph-ingest/integration.test.js` fails on a clean tree (a channel-filter
assertion, unrelated to this work); ignore that one, everything else must be green.
**Provider APIs:** Slack `chat.postMessage` (`thread_ts`) and `chat.getPermalink`.
Both are already available to the bot token — no new scopes.

## The problem

Every PR message the bot sends is a flat post in the owner's DM: the draft-ready
card, the merge confirmation, the reviewer's tail, the job-failed dump, and every
action reply. Six call sites, all `chat.postMessage` straight to
`dm.channel.id`. After a busy morning the conversation about #458 is interleaved
with three other PRs and there is no way to gather it back up.

So: give each PR **one thread**, put every message about that PR in it, and put a
`💬 Slack thread` entry in the row's menu that opens it.

## What exists already, and must be reused rather than rebuilt

- `src/services/pr-tasks.js` — `_addColumn(name, decl)` bolts a column onto
  existing DBs; every column added after the review lane shipped uses it. The
  prepared statement `byKey` (`WHERE repo=? AND number=?`) already exists but has
  no public wrapper.
- `overflow(taskId, entries)` in `src/channels/slack/pr-board.js` — supports a
  per-option `url`, which Slack opens client-side.
- The `pr_menu` handler in `socket.js` already early-returns for `pr_open`
  (`// the option's url did the work`).
- `tests/channels/pr-wiring.test.js` — a `SlackSocketHandler` harness built with
  `Object.create(prototype)` and a fake `app.client`. This is where the
  threading behaviour gets tested; do not build a second harness.

## Task 1 — remember the thread (`src/services/pr-tasks.js`)

Two columns via the existing `_addColumn` helper, with a comment in the file's
voice explaining what NULL means:

```js
// The DM thread where every message about this PR lands, and the permalink to
// it. Both NULL until the bot first has something to say — a PR nobody has
// spoken about has no thread to link to, which is why the menu entry is
// conditional rather than always present.
this._addColumn('slack_ts', 'TEXT');
this._addColumn('slack_permalink', 'TEXT');
```

Add two methods:

- `setSlackThread(id, ts, permalink)` — writes both, bumps `updated_at`.
- `byRepoNumber(repo, number)` — public wrapper over the existing `byKey`
  statement. Needed by the job call sites, which know `payload.repo` /
  `payload.pr` but not the task id.

Test in `tests/services/pr-tasks.test.js`: `setSlackThread` round-trips through
`get()`, and a fresh row has both columns NULL.

## Task 2 — post into the thread (`src/channels/slack/socket.js`)

Two new methods on the handler. Keep them next to `_onJobResult`.

```js
/**
 * The ts of this PR's DM thread, creating it on first use. The anchor is a
 * header message rather than whichever notification happened to arrive first,
 * so the permalink lands on something that says which PR this is.
 */
async _prThreadTs(task, channel) { ... }

/** Post a message about a PR into that PR's thread. */
async _postForPr(task, message) { ... }
```

`_prThreadTs`:
1. Return `task.slack_ts` when set — no API call on the common path.
2. Otherwise post the anchor:
   `*<${task.url}|${task.repo}#${task.number}>* — ${titleOf(task)}`, with
   `unfurl_links: false, unfurl_media: false` like every other post here.
3. Call `chat.getPermalink({ channel, message_ts: res.ts })`.
4. `this.prTasks.setSlackThread(task.id, res.ts, permalink)`.

**Persist the ts even when `getPermalink` fails.** Threading is the load-bearing
half; the link is the convenience. A failed permalink lookup must leave a working
thread and a NULL permalink (warn and continue), not lose the thread because the
nice-to-have threw.

`_postForPr(task, message)` resolves the owner DM, gets the ts, and posts with
`thread_ts` plus `unfurl_links: false, unfurl_media: false`.

Then convert the six sites. All of them keep their current text and blocks
untouched — only where the message lands changes:

| Site | How it gets the task |
|---|---|
| `_onJobResult` `apex_review` | already has `task` |
| `_onJobResult` `merge_pr` | `byRepoNumber` from the payload |
| `_onJobResult` `pane_message` | `byRepoNumber` from the payload |
| `_onJobResult` `pane_close` | `byRepoNumber` from the payload |
| `_onJobFailed` | `byRepoNumber` from the payload |
| the three `handlePrAction` reply posts (`pr_menu`, the `prActionIds` loop, the `pr_revise` view submission) | `prTasks.get(taskId)`, which the handler already resolves |

**When no task resolves, post flat exactly as today.** A `review` job (not
`apex_review`) has no PR row at all, and a payload can be missing `repo`/`pr`.
Losing a message because its thread could not be found would be worse than the
scattering this change exists to fix.

The `pr_revise` site currently passes `text: reply` unconditionally — leave that
as it is, it is the one handler that always answers with a string.

## Task 3 — the menu entry (`src/channels/slack/pr-board.js`)

In **`mineLaneBlocks`** and **`teamLaneBlocks`**, insert one entry directly above
`🔗 Open on GitHub` — actions first, links last:

```js
{ text: '💬 Slack thread', actionId: 'pr_thread', url: task.slack_permalink }
```

**Only when `task.slack_permalink` is set.** An overflow option with a missing
`url` is a dead tap, and Slack rejects an empty string outright. Build the entry
list conditionally rather than filtering a literal with a falsy hole in it.

In `socket.js`, extend the existing `pr_menu` early return:

```js
// pr_thread and pr_open are both pure links: Slack has already opened the
// option's url by the time this fires.
if (actionId === 'pr_open' || actionId === 'pr_thread') return;
```

No `handlePrAction` case, no new registered action.

**The review lane keeps its buttons.** Its rows render `🔍 Review now` /
`📤 Post` / `✏️ Edit` / `🗑 Discard` as buttons with no overflow, and a fifth
button for a link is noise on the lane where the work actually happens. Out of
scope here.

Tests in `tests/channels/pr-board.test.js`:
- a `mine` row with `slack_permalink` set exposes a `pr_thread` option carrying
  that url, positioned immediately before `pr_open`;
- the same row without one exposes exactly the three existing options and no
  option with a missing `url`;
- same pair for a `team` row.

## Task 4 — prove the threading in the harness

In `tests/channels/pr-wiring.test.js`. The harness's `postMessage` mock currently
resolves `{}`; give it a `ts` and add a `chat.getPermalink` mock.

- The first message about a PR posts twice — an anchor with no `thread_ts`, then
  the real message with `thread_ts` set to the anchor's ts — and persists both
  `slack_ts` and `slack_permalink` on the row.
- A second message about the same PR posts **once**, in that thread, and calls
  neither `getPermalink` nor the anchor path again.
- `getPermalink` rejecting still leaves `slack_ts` written and the message
  delivered in-thread, with `slack_permalink` NULL.
- A job whose payload matches no PR row still gets its message delivered, flat.

## Task 5 — verify

Full suite green but the known `graph-ingest` failure. Commit to `release` with a
message in the repo's voice: subject says what changed for the reader, body says
why. **Do not push.**

## Out of scope — do not build

Backfilling threads for PRs the bot has already posted about (they start
threading from their next message). Moving the App Home board itself into a
thread. Posting to a channel instead of the owner DM. Adding the entry to the
review lane. Resolving GitHub threads from Slack.
