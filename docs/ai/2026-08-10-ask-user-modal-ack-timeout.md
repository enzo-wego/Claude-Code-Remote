# Fix: ask_user modal shows "We had some trouble connecting" after a successful answer

## Symptom (observed 2026-08-10)

A user submits an `ask_user` single-modal in Slack. The modal stays open with a red
banner: **"We had some trouble connecting. Try again?"** — but the thread behind it
already shows `*Question answered.*` / `@Enzo answered: next=verify_only, wording=…`.

So the answer landed, the agent unblocked, and the user was told it failed.

## Root cause

`src/mcp/poster.js:180-188` — the Bolt view handler acks only *after*
`handleViewSubmission()` resolves:

```js
slackApp.view(/^ask_user:/, async ({ ack, body, view, client }) => {
    try {
        const ackPayload = await handleViewSubmission({ body, view, client });
        await ack(ackPayload || {});
    ...
```

`src/mcp/poster.js:324-332` — the single-modal branch **awaits** a Slack API round
trip before returning:

```js
const answers = extractAnswersFromView(view);
askUserTool.resolvePending(requestId, { answers, status: 'ok' });   // answer recorded

if (client && channel && slackTs) {
    await updateBootstrapWithAnswers(client, channel, slackTs, answers, body).catch(...)  // <-- blocks the ack
}
return null;
```

Slack's view_submission ack budget is 3 seconds. `updateBootstrapWithAnswers` is a
`chat.update`; on a 429 or 5xx the Slack WebClient retries with exponential backoff,
which alone can exceed 3s. Slack then treats the submission as failed, keeps the modal
open, and renders the connection banner — even though `resolvePending` already fired.

The **wizard** final-step path at `src/mcp/poster.js:367-371` already fire-and-forgets
the same call. The single-modal path was never brought in line with it.

## Goal

Ack the view submission promptly so a slow `chat.update` can never surface as a
"trouble connecting" error on an answer that was, in fact, recorded.

## Non-goals

- Do NOT restructure the wizard step flow. Wizard steps must keep returning
  `{ response_action: 'update', view }` from `handleViewSubmission` before the ack —
  that payload IS the ack.
- Do NOT fix the retry-drop hazard in this change (see "Follow-up" below).
- No new dependency, no new abstraction, no retry/queue layer.

## Files expected to change

- `src/mcp/poster.js` — one call site.
- `tests/mcp/` — one new or extended test (see acceptance).

## Approach

In `handleViewSubmission` (`src/mcp/poster.js:327-331`), drop the `await` on
`updateBootstrapWithAnswers` so the single-modal path matches the wizard path at
line 367-371. The `.catch(...)` handler is already attached, so an unawaited
rejection cannot become an unhandled rejection.

```js
    if (client && channel && slackTs) {
        updateBootstrapWithAnswers(client, channel, slackTs, answers, body).catch((err) =>
            logger.warn(`failed to update bootstrap after modal submit: ${err.message}`),
        );
    }
    return null; // close the modal
```

Add a short comment naming why it is not awaited (Slack's 3s ack budget), so a future
reader does not "fix" it back. Keep it to one or two lines — the reasoning belongs
here in the doc, not as an essay in the source.

## Acceptance criteria

1. `handleViewSubmission` returns without waiting on the `chat.update` promise:
   a test where `client.chat.update` returns a promise that never settles must still
   see `_handleViewSubmission(...)` resolve (assert with a real timer race or by
   resolving the returned promise before the update mock settles).
2. The bootstrap update still gets called with the same arguments as today
   (channel, ts, and a summary containing the answers) — behaviour is unchanged,
   only the awaiting is.
3. `askUserTool.resolvePending` is still called exactly once, before the update.
4. The wizard path is untouched: `handleViewSubmission` on a `:wizard` callback_id
   with a remaining visible step still returns `{ response_action: 'update', view }`.
5. Existing tests in `tests/mcp/` all pass — in particular `wizard.test.js`,
   `open-modal.test.js`, `bootstrap-action.test.js`.
6. No TODO placeholders, no `test.skip` / `test.only`, no stubbed assertions.

## How to verify

```bash
npx jest tests/mcp --runInBand
```

Report the full pass/fail summary. If the repo's jest needs Node 22 via nvm on this
machine, use it — do NOT run `npm rebuild better-sqlite3`.

Then show `git diff` for `src/mcp/poster.js` so the change can be read as a whole.

## Follow-up (out of scope, report only)

Pressing **Try again?** on a timed-out modal re-submits: `resolvePending` finds no
pending entry (already deleted), logs `resolvePending: no pending entry for <id>`,
and the modal closes with the retry's answers silently discarded. With this fix the
timeout becomes rare, but the drop is still wrong — if the user edits their answer on
the retry, the edit is lost with no signal. Worth a separate change that either
surfaces "this question was already answered" in the modal or updates the recorded
answer.
