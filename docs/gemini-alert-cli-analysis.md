# Gemini alert-CLI failure analysis (FIX C escalations)

> Temp analysis note — 2026-07-06. Written while investigating why Gemini keeps
> failing as the lead alert CLI. Kept so it can be re-checked after Gemini is
> replaced with **Antigravity** in the alert chain.

## TL;DR

- Gemini is the **first CLI** launched for PagerDuty alert investigations
  (`ALERT_CLI` chain, Gemini → Codex → …).
- It repeatedly **does the work but never posts a report**, then parks idle at
  its prompt. The `hitIdleAfterWork` watchdog (**FIX C**) escalates to Codex
  after 3 min.
- Over the journal window (since FIX C landed 2026-06-30): **6 real "no report"
  escalations, 100% of them Gemini → Codex.** Codex recovered every one.
- Root cause is **upstream (Gemini)** and there is **no clean bot-side fix**.
  Pragmatic action: **demote Gemini below Codex / replace with Antigravity.**

## The triggering incident (the thread that started this)

- Thread: `C08S954G2LX` / `1783297677.116909` (Payments – Authorization
  availability, 2026-07-06 00:27 UTC / 07:27 GMT+7).
- Bot posted: `:repeat: gemini ran idle at prompt 3min after working (no report)
  — restarting investigation with codex...`
- Codex then produced the report (🟠 Should take a look — Juspay /txns HTTP 400,
  bow_hot US hotel orders) + attachment + on-call ping at 00:39 UTC.

## Mechanism (why the report is lost)

1. Gemini's TUI parks the outer agent on `! Shell awaiting input (Tab to focus)`.
   Per code comments this happens when either:
   - a shell tool it ran is blocking on stdin, **or**
   - (more common) `--yolo` does **not** cover Gemini's **MAX_TURNS recovery
     turn**. The alert investigations are long (9–13 KB of work) and exhaust the
     turn budget, hitting a recovery prompt yolo won't auto-accept.
2. Our poller's `_autoApprove` detects `Shell awaiting input` and sends
   **`Escape`** to un-stick it (`src/channels/slack/socket.js:5262-5269`).
3. **In Gemini, `Escape` = cancel the entire turn.** The shell unsticks but the
   turn dies → `Request cancelled.` → no turn-final assistant message →
   `AfterAgent` hook never fires → **no report ever reaches Slack.**
4. Session then sits idle at the empty prompt. FIX C
   (`socket.js:4155`, `hitIdleAfterWork`) trips after `idleAfterWorkMs`
   (default 3 min) → kills tmux → recursive `_processCommand` on the next CLI
   in `session.injectChain` (Codex).

### The core dilemma (why "just fix it" doesn't work)

Once Gemini has parked on `Shell awaiting input`, **no single keystroke both
frees the shell AND preserves the turn:**

| Action | Shell freed? | Turn preserved? | Result |
|---|---|---|---|
| `Escape` (current) | ✅ | ❌ (turn cancelled) | Fast loss → fast fallback (3 min) |
| Do nothing | ❌ | — | Parks forever → 30-min idle burn (the old bug this replaced) |

So *given the parked state*, the report is already lost. Escape just makes the
loss fast so Codex can take over quickly. This is working as designed — the bug
is that Gemini gets into that state at all.

## Key code references

| What | Location |
|---|---|
| FIX C watchdog (idle-after-work escalation) | `src/channels/slack/socket.js:4044-4055`, gate at `:4155-4157` |
| Escalation / restart-with-next-CLI + Slack `:repeat:` notice | `src/channels/slack/socket.js:4193-4219` |
| `Shell awaiting input` → send `Escape` | `src/channels/slack/socket.js:5262-5269` |
| Gemini adapter: `confirmationPrompts`, `handlesConfirmationPrompts` | `src/cli/gemini-adapter.js:258-266` |
| Gemini launch cmd `gemini --yolo --skip-trust` | `src/cli/gemini-adapter.js` `buildLaunchCommand` |
| Gemini geo-block fatal pattern + US egress proxy | `src/cli/gemini-adapter.js` `fatalErrorPatterns`, `extraLaunchEnv` |

## Log evidence (journal, GMT+7)

FIX C fired **25** times total:
- **19** were harmless "post-success idle" (report already posted; the finishing
  CLI just parked after posting — logged `Post-success idle`, no action).
- **6** were real "no report" escalations. **All 6 were Gemini → Codex:**

| Date (GMT+7) | Alert session | Gemini buffer discarded |
|---|---|---|
| 2026-07-01 07:42 | slack-G2LX-865859618419 | — |
| 2026-07-01 10:15 | slack-G2LX-875456678649 | 9,876 chars |
| 2026-07-02 09:18 | slack-G2LX-958077359069 | — |
| 2026-07-02 13:28 | slack-G2LX-973377042709 | 11,172 chars |
| 2026-07-04 00:39 | slack-G2LX-099640365409 | 13,065 chars |
| 2026-07-06 07:32 | slack-G2LX-297677116909 | 2,861 chars (this thread) |

Each shows `Creating tmux session (cli=gemini)` → work → 3-min idle →
`Creating tmux session (cli=codex)` on the same alert. Not one Codex/Claude
trip. Buffer sizes confirm Gemini did real (wasted) investigation each time.

Rate: **~1–2 Gemini stalls/day** as lead alert CLI since FIX C landed. Every one
recovered via Codex, but each cost a wasted turn + ~3 min latency.

### How to re-check later (after Antigravity swap)

```bash
J() { journalctl -u claude-remote --no-pager -o cat; }
# total FIX C trips
J | grep -c 'WARN.*idle at prompt.*after working'
# harmless post-success ones
J | grep -c 'INFO.*Post-success idle.*after working'
# real escalations = difference; list them:
J | awk '/WARN.*idle at prompt.*after working/{w=$0;getline n;if(n!~/Post-success idle/)print w}'
# which CLI was launched for a given session id:
J | grep <session-id> | grep 'Creating tmux session'
```

If after replacing Gemini with Antigravity the "real escalation" count stops
growing, the swap fixed it.

## Options considered

1. **Bot-side: close only the shell, not the turn.** Instead of `Escape`, `Tab`
   to focus the stuck shell then send `C-d` (EOF) / `C-c` to end just that
   command so the tool returns and the turn continues to `AfterAgent`.
   - Untested, uncertain. Only helps the stdin-block sub-case, not MAX_TURNS.
2. **Bot-side: stop it parking.** Raise Gemini turn/session budget so long alert
   investigations don't hit the MAX_TURNS recovery turn, or trim the alert skill.
   - Attacks the common cause but is fiddly and Gemini-version-fragile.
3. **Upstream (Gemini).** Real fix: don't park on shell-awaiting-input, and/or
   make Escape not nuke the whole turn, and/or have `--yolo` cover the recovery
   turn. Out of our control.
4. **Demote / replace Gemini (chosen direction).** Gemini is 0-for-6 as lead and
   adds only latency. Move it below Codex, or **replace with Antigravity**. The
   existing fallback chain makes this seamless.

## Decision / next steps

- [ ] Replace Gemini with **Antigravity** in `ALERT_CLI` (and `DELAY_ALERT_CLI`
      if present). Verify the adapter + hook wiring for Antigravity.
- [ ] After the swap, re-run the log-check snippet above to confirm the FIX C
      "real escalation" count stops growing.
- [ ] (Optional) Keep Gemini last in the chain only if it ever adds value;
      otherwise drop it entirely.
