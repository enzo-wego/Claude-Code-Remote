# Thread-aware turn: a PR is not done while a comment is still waiting

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` (repo convention — commit there, no feature branch).
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory** on this Mac. `better-sqlite3@12.6.2` cannot build
against Homebrew Node 26 (V8 14 removed `v8::PropertyCallbackInfo::This()`), so
every DB-backed test fails under the default `node`. Do **not** `npm rebuild
better-sqlite3` to "fix" that — it destroys the working Node 22 binding.
**Provider APIs:** none. GitHub GraphQL only, with the token the bot already has.

## The problem, on real data

PR #458 rendered as `💬 waiting on reviewers` while three CodeRabbit threads sat
unanswered. The board could not know: **thread resolution state does not exist in
the REST API.** `GET /pulls/{n}/comments` returns comments with no resolved flag,
so every sweep so far has been blind to it. GraphQL's `reviewThreads` has it.

Ground truth for #458 at the time of writing (verified against both the Mac and
the VPS token):

```
8  isResolved=true                                    → done
1  isResolved=false isOutdated=true  last=enzo-wego   → code moved on, nothing to do
3  isResolved=false isOutdated=false last=coderabbitai → waiting on Enzo   ← invisible today
```

## The rule

No new concept is needed. It is the **existing who-spoke-last rule, applied per
thread instead of per PR**:

```
needsMe(thread) = !isResolved && !isOutdated && lastCommentAuthor != viewerLogin
openThreads     = count of threads where needsMe
turn            = openThreads > 0 ? 'mine' : <existing PR-level logic>
```

Dispute and defer need no marker syntax and nothing taught to the bot. Reply
"not doing this, follow-up ticket" and **you** are the last author, so the thread
stops counting while staying open on GitHub. Resolve it instead and `isResolved`
handles it. Two escape hatches, both already habits.

`isOutdated` is load-bearing, not a nicety: without it that ninth thread — an old
reply of Enzo's against code that has since moved — keeps the row yellow forever.

## Tasks

### 1. `fetchReviewThreads` in `src/services/pr-monitor.js`

Add next to the existing REST helpers. One GraphQL POST per PR to
`https://api.github.com/graphql`, same bearer token every other call in this file
uses (`ghHeaders`). Verified working with the bot's own token; scopes
`gist, read:org, repo`.

```graphql
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(last:1) { nodes { author { login } createdAt } }
        }
      }
    }
  }
}
```

Export two things, and keep the counting **pure** so it is testable without a
network: `fetchReviewThreads()` (does the POST, returns
`response.data.repository.pullRequest.reviewThreads.nodes`) and
`countOpenThreads(nodes, viewerLogin)` (applies the rule above).

Requirements on `countOpenThreads`:
- A node whose `comments.nodes` is empty counts as **needing you** — an
  unreadable thread must not silently read as "handled". Fail toward visible.
- Author comparison is case-insensitive; `author` may be `null` for a deleted
  account, which also counts as needing you.
- Returns a number, never null.

`fetchReviewThreads` must not throw the sweep down: on a non-200, a GraphQL
`errors` array, or a malformed body, log at warn and return `null` — distinct
from `[]`, so the caller can tell "no threads" from "could not tell".

Pagination: `first: 100` with no cursor is deliberate. Log a warn if
`nodes.length === 100` so a PR that ever exceeds it is not silently truncated.

### 2. `open_threads` on `pr_tasks`

`src/services/pr-tasks.js`: `this._addColumn('open_threads', 'INTEGER')` with the
existing helper, plus a `setOpenThreads(id, count)` setter beside `setTurn`.
**Leave it NULL when `fetchReviewThreads` returned null** — do not write 0, which
would claim "nothing waiting" on a failed lookup.

### 3. Wire it into the sweeps

The per-PR detail passes already run under `mapLimit` with `DETAIL_CONCURRENCY`;
add the thread fetch there so concurrency stays bounded. Apply to **all three
lanes** — the rule is symmetric: on a PR you are reviewing, a thread where the
author spoke last is equally your move.

### 4. `turnOf()` gains the thread signal

The thread check goes **first**, ahead of the `approved → 'done'` rule. An
approved PR with three unanswered nits is not finished, which is the entire point
of this change. When `open_threads` is NULL or 0, `turnOf` must behave exactly as
it does today — this change adds a reason to be yellow, it removes none.

**Do not touch the 🚀 Merge accessory.** It keys on `review_decision === 'approved'
&& ci === 'green'`, and merging remains Enzo's call even with threads open.
Removing it here would be a second, unasked change.

### 5. Row display in `src/channels/slack/pr-board.js`

Add the count to the row's columns when `open_threads > 0`, e.g.
`🟡 3 threads open · your move`. At 0 or NULL the row must render byte-identical
to today. Singular/plural: `1 thread open`.

### 6. Tests — `tests/services/pr-threads.test.js`

Pure, fixture-driven, no network:
- `countOpenThreads` against a fixture mirroring #458's twelve nodes → **3**.
- Resolved-but-author-is-someone-else → not counted.
- Unresolved + outdated → not counted (the regression this guards).
- Unresolved, last author is you in different case (`Enzo-Wego`) → not counted.
- Empty `comments.nodes` → counted.
- `author: null` → counted.
- `turnOf` with `open_threads: 3` and `review_decision: 'approved'` → `'mine'`.
- `turnOf` with `open_threads: 0` → unchanged from today's expectations.
- `buildPrBoardBlocks` renders `3 threads open`, and renders nothing extra at 0.
- `fetchReviewThreads` returns `null` on a GraphQL `errors` payload (inject a
  fake `fetch`, as `tests/channels/pr-board-layout.test.js` already does).

### 7. Verify

```
PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest
```

Full suite must be green except the pre-existing
`tests/graph-ingest/integration.test.js` localhost-binding failure, which fails
the same way on a clean tree. Commit to `release`. **Do not push** — Enzo pushes
and deploys.

## Out of scope

Resolving threads *from* Slack, an `address_comments` job, and the
`changes_requested` trigger are all later. This change only makes the board tell
the truth about whose move it is.
