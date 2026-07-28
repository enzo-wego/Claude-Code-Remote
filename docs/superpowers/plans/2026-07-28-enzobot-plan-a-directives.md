# EnzoBot Plan A — Directives (Claims) + MCP Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the Entity a unified, synced identity + rule store as graph Claims, injected into every CLI session on every machine, and expose agent-mem memory as MCP tools.

**Repository:** **`agent-mem`** (`~/go/src/github.com/agent-mem`, Go). This is a DIFFERENT repo from the others — a Go/Postgres/pgvector project. No code dependency on Plans B/D/E; run in parallel.

**Provider APIs:** **No NEW provider call for directives.** Directive CRUD + session-start injection is plain Postgres + text rendering. agent-mem ALREADY calls Gemini (extraction/summarization) and Anthropic (graph querying) with an OpenRouter toggle (`internal/openrouter` / `openrouter.js`, `settings` table holds `llm_provider`); Plan A reuses that existing layer only if a rule needs graph enrichment — it adds no new SDK, key, or client. The MCP shim exposes existing HTTP endpoints; it performs no LLM calls itself.

**Architecture:** A new `graph.directives` table (Claims with provenance/scope/supersede edges into existing graph tables), three REST endpoints behind the existing Bearer middleware, an addition to the existing `handleSessionStart` context builder, and a thin MCP server (stdio + streamable-HTTP) wrapping the existing `/api/graph/*`, `/api/search`, and new `/api/directives` routes.

**Read first (existing code):** `internal/worker/server.go` (routes), `internal/worker/handlers.go` (`handleSessionStart`), `internal/context/builder.go` + `render.go` (injection), `internal/graph/handlers/router.go` (Bearer auth), `migrations/` (schema pattern), `internal/database/models.go`.

---

## File structure (agent-mem)

| File | Responsibility |
|---|---|
| `migrations/20260728000001_directives.sql` (new) | `graph.directives` table + indexes |
| `internal/database/directives.go` (new) | CRUD queries + `Directive` model |
| `internal/worker/directives_handlers.go` (new) | `GET/POST/PATCH /api/directives` |
| `internal/worker/server.go` (modify) | Mount the three routes behind Bearer |
| `internal/context/directives.go` (new) | Render "Who you are" + "Standing rules" block |
| `internal/context/builder.go` (modify) | Call the directives renderer in `BuildContext` |
| `cmd/agent-mem/mcp.go` (new) | `agent-mem mcp` subcommand — the MCP shim |
| `internal/mcp/server.go` (new) | MCP tool defs wrapping HTTP endpoints |
| `plugin/skills/directive-cli/` (new, optional) | curl wrapper so the companion can write rules |

---

### Task 1: Schema migration

**Files:** Create `migrations/20260728000001_directives.sql`

- [ ] **Step 1:** Write the migration (follow the existing `graph` schema migration style):

```sql
-- graph.directives — the Entity's identity + learned rules, as Claims.
CREATE TABLE IF NOT EXISTS graph.directives (
    id           BIGSERIAL PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('persona','rule')),
    content      TEXT NOT NULL,
    category     TEXT,
    source       TEXT NOT NULL DEFAULT 'taught' CHECK (source IN ('taught','inferred')),
    confidence   REAL NOT NULL DEFAULT 1.0,
    -- provenance: the episode/observation this was derived from (nullable)
    derived_from TEXT,
    -- scope: entity ids this applies to (empty = global). GIN for fast lookup.
    applies_to   TEXT[] NOT NULL DEFAULT '{}',
    -- versioning: the directive id this supersedes (kept addressable, not deleted)
    supersedes   BIGINT REFERENCES graph.directives(id),
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- sync columns (match the pattern in existing tables)
    sync_status  TEXT NOT NULL DEFAULT 'pending',
    sync_updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_directives_active ON graph.directives(active, kind);
CREATE INDEX IF NOT EXISTS idx_directives_applies_to ON graph.directives USING GIN (applies_to);
```

- [ ] **Step 2:** Apply per the repo's migration runner (`make migrate` or `agent-mem migrate` — check the Makefile). Verify: `\d graph.directives` in psql shows the table.
- [ ] **Step 3:** Commit `feat(graph): directives (claims) schema`.

---

### Task 2: Directive model + CRUD

**Files:** Create `internal/database/directives.go`; Test `internal/database/directives_test.go`

- [ ] **Step 1:** Write the failing test (Go, using the repo's existing DB test harness — mirror `models_test.go` / whatever exists; if the repo tests against a real Postgres via `TEST_DATABASE_URL`, follow that):

```go
func TestDirectiveCRUD(t *testing.T) {
    db := testDB(t) // existing helper
    d, err := db.CreateDirective(ctx, Directive{Kind: "rule", Content: "no pings during lunch", Source: "taught"})
    require.NoError(t, err)
    require.NotZero(t, d.ID)

    active, err := db.ActiveDirectives(ctx)
    require.NoError(t, err)
    require.Len(t, active, 1)

    // supersede: new rule replaces old, old stays addressable but inactive-for-injection
    d2, err := db.SupersedeDirective(ctx, d.ID, Directive{Kind: "rule", Content: "no pings 12-13"})
    require.NoError(t, err)
    active2, _ := db.ActiveDirectives(ctx)
    require.Len(t, active2, 1)
    require.Equal(t, d2.ID, active2[0].ID)
    old, _ := db.GetDirective(ctx, d.ID)
    require.False(t, old.Active) // superseded → not injected, still queryable
}
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the `Directive` struct + methods: `CreateDirective`, `GetDirective`, `ActiveDirectives`, `ActiveDirectivesForScope(entityIDs []string)`, `SupersedeDirective` (insert new with `supersedes=oldID`, set old `active=false` in one tx), `UpdateDirective`. Use the repo's existing `pgx`/`database/sql` style.
- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 3: REST endpoints

**Files:** Create `internal/worker/directives_handlers.go`; Modify `internal/worker/server.go`.

- [ ] **Step 1:** Implement handlers:
  - `GET /api/directives?scope=<entityId>` → active directives (global + scoped if `scope` given). JSON `{directives:[...]}`.
  - `POST /api/directives` → body `{kind, content, category?, source?, derived_from?, applies_to?[]}` → created row.
  - `PATCH /api/directives/{id}` → `{content?, active?, supersede?:bool}`; if `supersede` create a new superseding row.
- [ ] **Step 2:** Mount behind the SAME Bearer middleware the graph routes use (see `router.go`). Add to `server.go` route registration.
- [ ] **Step 3:** Test with curl against a local worker:

```bash
curl -s -XPOST localhost:34567/api/directives -H "Authorization: Bearer $AGENT_MEM_API_KEY" \
  -H 'content-type: application/json' -d '{"kind":"rule","content":"drafts stay out of the brief"}'
curl -s localhost:34567/api/directives -H "Authorization: Bearer $AGENT_MEM_API_KEY"
```

Expected: create returns the row; list includes it.

- [ ] **Step 4:** Commit.

---

### Task 4: Session-start injection

**Files:** Create `internal/context/directives.go`; Modify `internal/context/builder.go`.

- [ ] **Step 1:** Implement `RenderDirectives(personas, rules []Directive) string` → a block:

```
## Who you are
<persona directives, joined>

## Standing rules
- <rule 1>
- <rule 2>
```

Persona = `kind='persona'`, rules = `kind='rule'`, active only. Scope filter: if the session
has a known project/entity, include global + matching `applies_to`; else global only.

- [ ] **Step 2:** In `BuildContext` (builder.go), fetch active directives and prepend the rendered block to the existing `<agent-mem-context>` output. Guard with an env flag `AGENT_MEM_DIRECTIVES_ENABLED` (default on) so it can be disabled.
- [ ] **Step 3:** Test: unit-test `RenderDirectives` (pure). Live-test: `POST` a rule, then hit `POST /api/hook/session-start` and confirm the response contains "## Standing rules" with the rule.
- [ ] **Step 4:** Commit.

---

### Task 5: MCP shim

**Files:** Create `cmd/agent-mem/mcp.go`, `internal/mcp/server.go`.

The shim is a thin MCP server exposing existing endpoints as tools. It makes NO LLM calls — it forwards to the local worker's HTTP API.

- [ ] **Step 1:** Add a Cobra subcommand `agent-mem mcp [--stdio | --http :PORT]`. Use a Go MCP server library (check what's available; if none vendored, a minimal JSON-RPC stdio loop is acceptable — the tools are simple).
- [ ] **Step 2:** Register tools, each forwarding to the worker (base URL `AGENT_MEM_WORKER_URL`, Bearer `AGENT_MEM_API_KEY`):
  - `graph_search(q, types?, limit?)` → `GET /api/graph/search`
  - `graph_resolve(seeds[], query?, asker_eeid?, depth?, budget_tokens?)` → `POST /api/graph/resolve`
  - `graph_node(url|id)` → `GET /api/graph/node`
  - `mem_search(q, project?)` → `GET /api/search`
  - `directive_list(scope?)`, `directive_add(kind, content, ...)`, `directive_update(id, ...)` → the Task 3 routes
- [ ] **Step 3:** Test: run `agent-mem mcp --stdio`, send a `tools/list` JSON-RPC request, confirm the tools enumerate; call `graph_search` and confirm it returns worker results.
- [ ] **Step 4:** Document install: add the MCP server to the companion's `.mcp.json` (server name `agent-mem`) so the companion session gets these as first-class tools. Note this in Plan B's companion-home setup as a follow-up.
- [ ] **Step 5:** Commit + push.

---

### Task 6: Migrate the companion persona into directives

- [ ] Once live, move the persona text from `companion/CLAUDE.md` (Plan B interim) into a `kind='persona'` directive via `POST /api/directives`. The companion now gets its identity from the synced graph, not a local file — same person on every machine/CLI.
- [ ] Verify: start a fresh Claude session on the Mac in any repo → its injected context contains the persona + rules. Start a Codex/Gemini session → same (session-start injection is CLI-agnostic).

---

## Self-review notes
- Provider APIs: none new. Directives are Postgres + text. agent-mem's existing Gemini/Anthropic/OpenRouter layer is untouched and only reused if graph enrichment is later added to a rule.
- Claims invariants (from the graph-engineering paper): every directive has `source` (taught|inferred) so inferred rules are distinguishable; `supersedes` keeps old versions addressable (never deleted); `applies_to` scopes injection; `derived_from` records provenance.
- Cross-repo: this is the ONLY plan in agent-mem. The companion (this repo) consumes it via session-start injection (automatic) + the MCP shim (tools).
