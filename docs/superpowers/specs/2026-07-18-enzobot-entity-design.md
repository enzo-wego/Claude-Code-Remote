# EnzoBot "Entity" — Personal AI Agent Design

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan
**Repos involved:** Claude-Code-Remote (this repo), agent-mem

## Vision

Turn EnzoBot from a reactive Slack relay into a benevolent version of The Entity
(Mission: Impossible — Dead Reckoning): an intelligence that has already read the
owner's whole digital world, never forgets, anticipates what he'll need, exists as
one continuous being across every machine — and uses all of that only to hand him
the right next move.

The deliberate inversion from the film: The Entity serves itself and manipulates.
EnzoBot serves Enzo, every belief it holds is inspectable, and Enzo holds the kill
switch.

**The nightly work cycle (core goal, per owner correction 2026-07-23):** the agent
works while Enzo sleeps, under *plan-approved autonomy*:

- **22:00 — plan:** analyze everything since yesterday 22:00 (PRs awaiting review,
  task/ticket status, stale threads) and draft a night work plan; **check Claude
  usage quota** to confirm the plan fits tonight's budget.
- **22:00 — confirm:** DM the plan + quota estimate to Enzo; one ✅ approves the batch.
- **overnight — work:** execute the approved batch autonomously (review drafts on the
  Mac, status analyses, preparation). No per-item approvals.
- **06:00 — report:** one DM with everything done (results, drafts ready to post),
  everything found, and the agent's proposed plan for Enzo's day.

Outward actions (posting reviews/replies, merging, ticket transitions) remain
owner-gated taps even inside an approved batch.

**Easy-task whitelist (no confirmation needed):** task kinds Enzo has marked easy
(e.g. review drafts for small PRs, daily status analysis, memory consolidation,
report preparation) run at midnight autonomously even if the 22:00 plan was never
confirmed. The whitelist is a set of directives Enzo edits by telling the agent.

**Becoming Enzo, day by day (the learning loop):** the nightly cycle is also study
time. Each night the agent reviews the day's evidence of Enzo's actual judgment —
which brief items he acted on vs ignored, how he edited its review drafts before
posting, what he replied in threads vs what the agent would have drafted, which
suggestions he rejected — and distills the deltas into directives (style, priorities,
taste). Success metric: the edit-distance between the agent's drafts and what Enzo
actually ships should shrink week over week.

## Core decisions (all confirmed with owner)

| Decision | Choice |
|---|---|
| Trust level | **Plan-approved autonomy** (revised 2026-07-23): nightly batch plan confirmed once at 22:00; easy whitelisted kinds run at midnight without confirmation; outward actions (posting/merging/transitions) always owner-gated taps. Daytime remains suggest-first. |
| The mind | **One durable DM companion session, kept resident** (revised 2026-07-23): the EnzoBot DM maps to a single resumable Claude Code session (session id in SQLite, auto-compaction). The process is kept alive 24/7 — exempt from idle kill; a keepalive sweep respawns it with `--resume` within seconds if dead — so it reacts to events in seconds and a crash/deploy never costs memory. Conversation = identity; resident process = readiness. |
| Pulses | Scheduled/triggered work = **injected turns into the companion**, not separate processes. One mind that did the thinking can explain the thinking. Three injection sources: **events** (the moment they pass the tier filters), a **heartbeat look-around** every ~15–30 min ("scan agenda/graph/streams — anything need action?" — usually answered with silence), and **scheduled thoughts** (22:00 plan, 06:00 report). |
| Open loops | New `agenda` table in `slack-sessions.db`. Personal messages (DMs, private channels) are read live via xoxc/xoxd and never persisted — only the derived agenda entry is. |
| Identity + rules | **Unified `directives` store in agent-mem** (persona + learned rules), synced across machines, injected into every session of every CLI via the existing session-start hook. One brain, one source of truth. |
| World / episodes | agent-mem graph (world model) and flat memory (episodic history) — both already wired to this repo. |
| Thread sessions | **One mind, many hands.** @mention/alert thread sessions stay parallel and ephemeral, but share the mind via directives injection, report back via Stop-hook flat-memory summaries, emit lifecycle whispers to the companion, and the companion can introspect live panes. |
| VPS ↔ Mac | Companion + perception live on the always-on VPS. Execution on the Mac (phase 2) via a **job queue the Mac polls** (outbound-only, sleep-safe) — no custom websocket. |
| Credentials | Read-scoped GitHub PAT + Jira API token added to VPS `.env` (Slack xoxc/xoxd already there). |
| Self-improvement | Night shift may **diagnose** itself and draft fixes as PR suggestions. It never self-deploys code. Autonomous scope = safe housekeeping only (retry jobs, re-arm timers, verify auth). |

## Architecture

```
PERCEPTION (24/7)                    MIND                            VOICE
Slack bot token ─→ graph-ingest ─┐  ┌────────────────────────────┐
Slack as-Enzo (xoxc, live) ──────┼─→│ DM companion session        │→ 08:30 brief
GitHub (read PAT) ───────────────┤  │ (durable, resumable)        │→ interrupts
Jira (read token) ───────────────┘  │                             │→ silence
                                    │ pulses = injected turns     │
agent-mem graph  ←─ /resolve ──────→│ memory via agent-mem MCP    │
agent-mem flat   ←─ hooks (auto) ──→│                             │
directives (persona+rules) ────────→│ injected at session start   │
agenda (SQLite)  ←─────────────────→└────────────────────────────┘
                                        ▲ lifecycle whispers / introspection
                              thread sessions ("hands", unchanged, parallel)
```

### Memory layers

| Layer | Answers | Store |
|---|---|---|
| World | "What's happening? Who/what relates to what?" | agent-mem graph (existing) |
| Episodes | "What did I do/discuss on Tuesday?" | agent-mem flat memory (existing, auto via hooks) |
| Directives | "Who am I? What has Enzo taught me?" | agent-mem `directives` (**new**) |
| Open loops | "What does Enzo owe / what's pending?" | `agenda` table in this repo (**new**) |

## Components

### 1. Companion session (this repo)
- DM channel key (channel-only, not thread) maps to one session row; `claude_session_id`
  never rotates. **Resident:** exempt from the inactivity timeout entirely (no idle tmux
  kill, no row deletion); a keepalive sweep (piggybacked on the existing `_sweepInterval`)
  respawns the tmux + `--resume` within seconds if the process is found dead. The
  dead-tmux resume path remains the crash-recovery fallback.
- Runs in a workspace dir on the VPS (`~/enzobot-home/`, scratch only — no memory files).
- Has the slack-ask MCP (ask_user) and the new agent-mem MCP.

### 2. Agenda (this repo)
`agenda(id, dedupe_key UNIQUE, kind, source_ref, title, evidence_json, status, priority,
first_seen, last_seen, snooze_until)` — additive migration in `_initDb()`.
`kind ∈ pr_review | thread_reply | jira | mail | custom`. `status ∈ open | done | snoozed | dropped`.
Written by the companion during pulses; updated by brief buttons.

### 3. Morning pulse — 08:30 brief
Scheduler (existing self-rescheduling `setTimeout` pattern) injects "run your morning
sweep" into the companion. A chief-of-staff skill guides it: run collectors
(Slack-as-you unreads/mentions, GitHub review-requests + own-PR status, Jira assigned
/transitions), enrich via graph `/resolve`, check yesterday's coding sessions via flat
memory, reconcile agenda, then DM a ranked Block Kit brief (top-3 next hour, reasons).
Buttons per item: ✅ done, 💤 snooze, ▶ work on it (seeds a normal thread session via
`_processCommand`). Interaction handling follows the existing `src/mcp/poster.js` pattern.
Manual trigger: `POST /pulse`. Collector failures degrade gracefully (brief notes the gap).

### 4. Real-time interrupts (tiered)
- **Tier 1 (v1):** heuristics in the existing `message` listener — mentions Enzo, watched
  topic, senior author, own-PR state change, incident channels. Kills ~90%.
- **Tier 2 (v1):** cheap classifier (Haiku via Agent SDK): "does Enzo need this before his
  next brief?" Survivors → DM notification with permalink + one-line why.
- **Tier 3 (v1.5):** survivors get injected into the companion for full judgment — speak,
  act (suggest), or stay silent — so the mind remembers every interrupt decision.

### 5. agent-mem: directives (new feature, Go)
- Table `directives(id, kind persona|rule, content, category, active, created_at,
  updated_at, sync_*)`.
- Endpoints `GET/POST/PATCH /api/directives`.
- Session-start injection gains `## Who you are` (persona) + `## Standing rules`
  (active rules) — every CLI, every machine. Trade-off accepted: no revision history
  (dashboard + `updated_at` are the audit trail).

### 6. agent-mem: MCP server (new, thin)
agent-mem currently has **no MCP transport** — HTTP + Bearer only. Add a thin MCP shim
(stdio or streamable-HTTP) exposing existing endpoints as tools, no new logic:
`graph_search`, `graph_resolve`, `graph_node`, `mem_search` (flat), `directive_list/add/update`,
`agenda` is NOT here (it lives in this repo; companion reaches it via a small skill or
this repo's MCP). Placement (inside Go worker vs small Node shim) decided at planning.

### 7. One mind, many hands (this repo)
- Thread sessions unchanged. Add: lifecycle whispers — on thread-session create/close,
  inject a one-liner into the companion ("started investigating PD-8842 in #payments-incidents").
- Introspection skill: companion may `tmux capture-pane` its own live sessions to answer
  "how's X going?" mid-task.

## Phases

**v1 — the companion + morning chief-of-staff + basic interrupts**
Companion session machinery · agenda table · chief-of-staff skill + 08:30 pulse +
brief with buttons · Slack/GitHub/Jira collectors · Tier 1+2 interrupts ·
agent-mem directives + injection · agent-mem MCP shim · read creds on VPS.

**Plan E — the night work cycle** (promoted to v1 core, 2026-07-23)
22:00 planning pulse (analyze since yesterday 22:00 → night plan → quota check →
confirm DM) · overnight batch execution via the Plan D job queue · midnight
easy-task whitelist (no confirm) · 06:00 report pulse (results + drafts + today's
plan) · nightly learning loop (distill Enzo's day-time decisions into directives —
"becoming Enzo") · consolidation (close stale agenda, session rebirth when needed).

**v1.5 — refinements** (needs live usage data to tune)
Tier-3 interrupt judgment · self-diagnosis → PR-suggestion drafts · Mail (Gmail)
collector · quota estimator upgraded from heuristic to measured usage.

**v2 — hands at scale**
Mac job-queue runner (`target_runner=local` polling daemon, launchd) for
execute-on-Enzo's-machine · companion-orchestrated hands (spawn/track delegated
sessions) · approval-gated actions (graduating from suggest-only per action type).

## Error handling

- Collector failure → brief ships with a "source unavailable" note; never blocks the pulse.
- Wedged sweep turn → existing watchdog/timeout machinery applies to the companion; a
  timed-out pulse is reported in-channel, next pulse re-runs (agenda dedupe_key makes
  re-runs idempotent).
- Companion tmux death → resume by session id (existing dead-tmux resume path).
- VPS restart → `_reconcileSessions` re-adopts the companion like any session; agenda
  and directives are durable stores.
- Interrupt storm → Tier 1/2 funnel plus a per-hour DM cap (companion-configurable rule).

## Testing

No test framework in repo (none configured). Per feature: `POST /pulse --dry-run`
(collectors run, brief printed to log, no DM) · one self-check script for agenda CRUD ·
directives: Go tests in agent-mem alongside existing patterns · manual verification
flow: trigger pulse, check DM, press buttons, verify agenda rows.

## Out of scope (explicit)

- Autonomous outward actions (posting replies, approving PRs, self-deploying code).
- Persisting personal DMs/private-channel content into any store.
- Custom websocket VPS↔Mac (job queue chosen instead).
- Replacing thread-session machinery (hands stay as-is).
