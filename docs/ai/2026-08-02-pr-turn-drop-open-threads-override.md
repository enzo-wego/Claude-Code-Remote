# Let author-vs-last-speaker decide the PR turn, alone

**Repo:** `Claude-Code-Remote` (Node.js, CommonJS, 4-space indent).
**Branch:** `release` — commit there, no feature branch. **Do not push.**
**Tests:** `PATH=/Users/neocapitelo/.nvm/versions/node/v22.19.0/bin:$PATH npx jest`
— **Node 22 is mandatory.** Do **not** `npm rebuild better-sqlite3` for any
reason. `tests/graph-ingest/integration.test.js` fails on a clean tree (a
channel-filter assertion, unrelated); ignore that one.
**Provider APIs:** none — no new GitHub or Slack calls.

## Goal

The owner states the board's rule as five cases, split by whether he authored
the PR:

**His own PR**
1. he commented last → no focus
2. approved → mergeable from Slack
3. someone else commented last and it is not approved → focus

**Someone else's PR**
4. the author commented last and it is not approved → ready to review
5. approved, or a non-author commented last → skip, the author still owes work

`turnFor()` in `src/services/pr-monitor.js:406` **already computes exactly
these five** — the XOR on its last line expands to them, verified case by case.
Nothing about the author/reviewer determination needs building.

What breaks the rule is the line above it:

```js
if (Number(openThreads) > 0) return 'mine';   // pr-monitor.js:413
```

Unresolved review threads pre-empt every rule, before approval and before the
last-speaker comparison — and `turnOf()` in `src/channels/slack/pr-board.js:60`
applies the same override a second time at render, against the stored column.
Rows go yellow that cases 1, 4 and 5 say should not.

**Delete the override, both copies.** Turn becomes a pure function of author,
last speaker and approval. That is the whole change.

## Non-goals — do not build

- **Do not touch `countOpenThreads()`** (`pr-monitor.js:133`). The count stays
  correct, stays stored, and stays on the row as a column via
  `openThreadsLabel()`. Only its power to *decide the glyph* is removed.
- **Do not touch the Merge button.** `mergeable` (`pr-board.js:230`) already
  keys off `review_decision === 'approved' && ci === 'green'`, independent of
  turn — an approved PR already offers 🚀 Merge today. Case 2 is shipped.
- Do not change lane assignment, `sweepReviewRequests`, `fetchActivity`, bot
  filtering, or the sort order in `byTurnThenAge`.
- Do not add a setting to switch the old behaviour back on. One rule, no flag.

## Files expected to change

| File | Change |
|---|---|
| `src/services/pr-monitor.js` | drop line 413; drop the now-unused `openThreads` param from `turnFor`'s signature (:411) and from both call sites (:627, :706); refresh the doc comment at :396 |
| `src/channels/slack/pr-board.js` | drop line 60 from `turnOf`; refresh the comment at :57 |
| `tests/services/pr-threads.test.js` | invert the `thread-aware turns` block; drop the now-meaningless `unknown count` test at :122 |

`src/services/pr-tasks.js` does not change — the `open_threads` column and
`setOpenThreads` stay exactly as they are.

## Approach

1. **`turnFor` (`pr-monitor.js:406`)** — remove the `openThreads` guard and the
   parameter. The body becomes: approved → `done`; otherwise the existing XOR.
   Removing the parameter rather than ignoring it is deliberate: a parameter
   that is accepted and unread is how this override quietly comes back.
2. **Both call sites (:622, :701)** — drop `openThreads,` from the object passed
   to `turnFor`. The local `const openThreads = …` above each stays; it still
   feeds `prTasks.setOpenThreads(...)`.
3. **`turnOf` (`pr-board.js:59`)** — remove the `open_threads` line. Keep the
   `TURN_GLYPHS[task.turn] ? task.turn : 'mine'` fallback and its comment: a row
   that predates the column, or one whose sweep failed, must still surface.
4. **Comments** — both functions carry a comment claiming threads outrank
   everything. Rewrite them to state the rule that now holds. A stale comment
   here is worse than none; it is what a future reader will believe.

## Acceptance criteria

`turnFor` returns, with `viewerLogin: 'enzo-wego'`:

| author | lastSpeaker | decision | expected | case |
|---|---|---|---|---|
| enzo-wego | enzo-wego | — | `theirs` | 1 |
| enzo-wego | reviewer | approved | `done` | 2 |
| enzo-wego | reviewer | — | `mine` | 3 |
| teammate | teammate | — | `mine` | 4 |
| teammate | teammate | approved | `done` | 5 |
| teammate | enzo-wego | — | `theirs` | 5 |

And the cases the five rules leave open, which must not regress:

- nobody has spoken yet on a teammate's PR (`lastSpeaker: null`) → `mine`, a
  fresh review request needs him;
- nobody has spoken yet on his own PR → `theirs`, the reviewers hold it.

Every row above must return the same value **regardless of `open_threads`** —
`0`, `3`, `null`, or the column absent entirely.

`turnOf` must return the stored `turn` verbatim for any `open_threads` value,
and `mine` only when `turn` is missing or unrecognised.

## Verify

- The truth table above as a table-driven test in
  `tests/services/pr-threads.test.js`, each row asserted at `open_threads: 3`
  as well as `0` — the whole point is that the count no longer matters.
- The existing rendering tests must still pass untouched: `3 threads open`
  still appears on the row, `1 thread open` stays singular, and
  `open_threads: 0` still renders byte-identically to a row without the column.
  If any of those needs editing, the count column was broken by mistake.
- The `renders the open count and keeps Merge available` test at :178 currently
  asserts `your move` on an approved row with 3 open threads. That expectation
  is the bug; it becomes `approved`. Keep its `pr_merge` accessory assertion —
  that part was always right.
- Full suite green but the known `graph-ingest` failure.

Commit to `release` with a message in the repo's voice: subject says what
changed for the reader, body says why the override existed and why it goes.
**Do not push.**
