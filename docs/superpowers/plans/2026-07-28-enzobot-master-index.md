# EnzoBot "Entity" — Master Plan Index

**Spec:** `docs/superpowers/specs/2026-07-18-enzobot-entity-design.md`
**Overview (human):** `docs/presentation/enzobot-entity.html` → https://claude.ai/code/artifact/12f45228-ec46-469d-9b0f-44cd6b408995

This is the entry point for anyone (human or agent) executing the Entity build. Read
this file first, then the individual plan it points to. Execute plans in the order below.

## Execution order

| # | Plan file | Repo(s) touched | Depends on |
|---|-----------|-----------------|------------|
| **1** | **`2026-07-28-enzobot-plan-h-home-task-board.md` (Plan H)** | Claude-Code-Remote | Plan B tasks 1,3,4,5,6 (agenda + collectors) |
| 2 | `2026-07-18-enzobot-companion-v1.md` (Plan B) | Claude-Code-Remote | — |
| 3 | `2026-07-23-enzobot-plan-d-mac-runner.md` (Plan D) | Claude-Code-Remote (+ Mac runner dir) | B |
| 4 | `2026-07-28-enzobot-plan-e-night-cycle.md` (Plan E) | Claude-Code-Remote | B, D |
| 5 | Enable (checklist in Plan B §11 + Plan D Task 8) | both machines' `.env` / config | B, D, E |
| 6 | `2026-07-28-enzobot-plan-a-directives.md` (Plan A) | **agent-mem** (Go) | — (parallelizable) |
| 7 | `2026-07-28-enzobot-plan-c-interrupts.md` (Plan C) | Claude-Code-Remote | B |

**Plan H is the new Step 1 (human-in-the-loop task board).** It builds the shared task board
on the Home tab — you and EnzoBot co-define tasks, you accept/reject its suggestions and
manually add/status your own — BEFORE any autonomy. It reuses Plan B's agenda store + collectors
(build those five tasks as part of H), and validates that EnzoBot picks the right work before
Plans D/E ever act unattended. When Plan B's companion/brief later lands, it reads/writes the
SAME agenda table, so the board and the brief stay in sync automatically.

**Provider APIs:** Plan H adds **none** — pure HTTP collectors + SQLite + Block Kit.

Plan A is in a **different repository** (`agent-mem`, Go). It has no code dependency on B/D/E
and can be executed in parallel by a separate worker. Everything else is in this repo
(`Claude-Code-Remote`, Node.js).

## Where the intelligence comes from (provider APIs)

This is the most important architectural fact for an executor: **almost none of the
"smart" is a provider API call in our code.** The judgment — ranking the brief, writing
the night plan, reviewing a PR, deciding what matters — is done *by the resident Claude
Code companion session and the herdr hands*, which are Claude Code processes authenticated
by the user's Claude subscription (no API key in our code). We inject text and read text.

Explicit provider API calls, by plan:

| Plan | Provider call in OUR code? | What / why |
|---|---|---|
| B | **No.** | Collectors are plain HTTP (Slack/GitHub/Jira REST). Ranking/brief authored by the companion Claude Code session (Anthropic via Claude Code auth, no key). Reuses the existing `@anthropic-ai/claude-agent-sdk` dep only if a headless summary is ever needed — not required for v1. |
| D | **No.** | Queue + runner are plumbing. The review itself is Claude Code running in a herdr pane (Anthropic via Claude Code auth). |
| E | **No new provider call.** | Plan, report, ratchet reasoning all happen inside the companion session. Quota estimate is a heuristic (job count × typical cost), pure arithmetic — no API. |
| A | **Yes — but already wired in agent-mem.** | agent-mem already calls **Gemini** (extraction/summarization) and **Anthropic** (graph querying), with an **OpenRouter** provider toggle (`openrouter.js`). Plan A's directives feature is CRUD + text injection — **no new LLM call**; graph/claim enrichment reuses agent-mem's existing provider layer. |
| C | **Yes — one cheap call.** | The Tier-2 interrupt classifier ("does Enzo need this before his next brief?") is a cheap per-event LLM call. Use the existing `@anthropic-ai/claude-agent-sdk` with a small model (Haiku) — the same dependency `daily-summary.js` already uses, Claude Code auth, no API key. Budget-guarded (per-hour cap) so cost stays trivial. |

**Rule for executors:** do NOT add a new provider SDK, API key, or HTTP LLM client unless a
plan's task explicitly says so. The only LLM dependency in this repo is
`@anthropic-ai/claude-agent-sdk` (already present); the only one Plan C adds a *call site*
for is that same package. All heavy reasoning is delegated to Claude Code sessions, not
API calls.

## Provider configuration that already exists (don't rebuild)

- **Claude Code auth**: the companion + hands use the user's Claude subscription. No key.
- **agent-mem**: `AGENT_MEM_*` env + its `settings` table hold `llm_provider`
  (`google` | `openrouter`), `anthropic_api_key`, `anthropic_model`. Plan A works within this.
- **`@anthropic-ai/claude-agent-sdk`**: already a dependency; used by `daily-summary.js`.
  Plan C reuses it. Auth is Claude Code (no `ANTHROPIC_API_KEY` needed).

## Repos at a glance

- **Claude-Code-Remote** (this repo, Node.js): the EnzoBot service, companion, agenda, jobs
  queue, collectors, Home tab, Mac runner. Plans B, C, D, E.
- **agent-mem** (`~/go/src/github.com/agent-mem`, Go): the knowledge graph + flat memory +
  (new) directives + MCP shim. Plan A.

## Status

- Spec: committed. Plan B: written. Plan D: written. Home tab v0: shipped + deployed.
- Plan A, C, E: written by this index's companion files (below). Execution: not started.
