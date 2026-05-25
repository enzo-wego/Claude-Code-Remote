# MCP `ask_user` — Interactive questions via Slack

## Problem

The bot runs an agent CLI (Claude Code / Codex / Gemini) inside tmux and relays
output to Slack. When the agent invokes an interactive question — Claude's
`AskUserQuestion` picker, Codex's `ask_user_question` tab picker, a permission
prompt, a diff approval, etc. — the TUI element renders inside the pane but
the remote Slack user can neither see the structured options nor select one.

Existing hook + poller paths can't cleanly bridge this:

- `PreToolUse` only fires for Claude's `AskUserQuestion`; Codex's analogue is
  not hook-covered (`openai/codex#9926`); Gemini has no structured equivalent.
- Hooks are permission gates only — they cannot supply the answer back to the
  tool, so even with a hook the picker still blocks on TUI input.
- Scraping the tmux pane for the picker frame is brittle (frame chars, line
  wrap, multi-tab navigation) and CLI-specific.

## Approach — MCP back-channel

Add a `slack-ask` MCP server hosted **in-process by the bot** that exposes one
tool, `ask_user`. Each CLI (Claude / Codex / Gemini) connects to it on
startup; when the agent needs to ask the user something, it calls `ask_user`
instead of its built-in picker. The tool call **blocks** inside the agent's
runtime, exactly like a slow `Bash` call. The bot posts the question to Slack,
waits for the user's reply, and resolves the held tool call with the answer.

```
question  : agent coding → MCP → bot → slack   (new wire, not tmux/hook)
answer    : slack → bot → MCP → agent coding   (same wire returns)
everything else (status output, completion): unchanged — still hook + tmux poller
```

The tmux pane just shows a normal `● ask_user(...)` tool-call line. No TUI
picker is rendered, no keystrokes need to be injected, no scraping.

### Why MCP (not hooks, not tmux scraping)

- **Works for all three CLIs.** Each one supports MCP servers natively.
- **Bidirectional in one round-trip.** The tool call is the question
  (output) *and* the answer (input). No separate input/output paths to
  reconcile.
- **No TUI dependence.** Frame chars, terminal width, picker layout — all
  irrelevant. The agent never sees the picker.
- **Channel layer owns the UX.** Slack-native Block Kit (buttons, modals,
  checkboxes) instead of trying to map a TUI picker.
- **Extensible.** Adding a second question type or a new interactive flow
  later is just another tool, not another adapter.

## Question taxonomy

After surveying what the three CLIs surface, four primitives cover the
space:

| Type | Purpose | Slack render |
|---|---|---|
| `select`  | Pick one or many from labeled options | Radio buttons / checkboxes inside a modal (or action-button row if ≤4 options and ≤1 line each) |
| `confirm` | N-button decision (yes/no, approve/approve-pattern/deny) | Action-button row in thread; `style: primary\|danger` mapped to Slack |
| `text`    | Free-form input | Plain text reply in thread, or a modal with `plain_text_input` for multiline |
| `preview` | Show a body + decision buttons (diff/plan approval) | Code-block snippet + action-button row; large bodies attached as file |

Plus a **multi-question / wizard** layout selected when the call carries
`questions[]` rather than a single question:

| Shape | Layout |
|---|---|
| 1 question | single render per type above |
| 2–N questions, no branching, all input-style | **single modal** with one input block per question |
| ≥1 conditional (`show_if`) OR contains `preview` OR >10 inputs | **wizard** — `views.push`/`views.update` step-by-step with Back/Next |

Slack Block Kit limits we honor: ≤100 blocks per view, ≤25 options per
select element, ≤2000 chars per text body before we attach as a file.

## Tool surface

```typescript
ask_user(input: {
  // Single-question shorthand
  type?:    "select" | "confirm" | "text" | "preview"
  question?: string

  // select
  options?:     { label: string, description?: string, value: string }[]
  multi?:       boolean
  allow_custom?: boolean

  // confirm
  buttons?: { label: string, value: string, style?: "primary" | "danger" | "default" }[]

  // text
  placeholder?: string
  multiline?:   boolean
  default?:     string

  // preview
  body?:                string
  language?:            string
  truncate_after_lines?: number

  // Multi-question / wizard
  questions?: Array<{
    id:       string                          // result key
    type:     "select" | "confirm" | "text" | "preview"
    question: string
    // ...per-type fields same as single
    show_if?: { question_id: string, equals?: string, in?: string[] }
  }>

  // Common
  title?:        string                       // modal title
  submit_label?: string                       // defaults to "Submit"
  layout?:       "auto" | "single_modal" | "wizard"
  timeout_ms?:   number                       // default 1_800_000 (30 min)
}) -> {
  // Single-question call → answer is the chosen value (or array if multi)
  answer?: string | string[]
  // Multi-question call → answers is keyed by question.id
  answers?: Record<string, string | string[]>
  // Either form may return:
  status: "ok" | "cancelled" | "timeout"
}
```

## Architecture

```
┌──────────────────────────── bot process (start-slack-socket.js) ────────────┐
│                                                                              │
│   ┌─────────────── Express ────────────────┐                                 │
│   │  POST /mcp/<session_id>   ◀── MCP ──┐  │                                 │
│   │  GET  /mcp/<session_id>   (SSE)     │  │                                 │
│   └─────────────────────────────────────┼──┘                                 │
│                                          │                                   │
│   ┌──── src/mcp/server.js ────┐  ┌───────▼────────┐  ┌────────────────────┐ │
│   │  Bootstraps MCP SDK       │──│ ask-user-tool  │──│  pendingQuestions  │ │
│   │  Routes /mcp/<id> to a    │  │  schema +      │  │  Map<id,resolver>  │ │
│   │  per-session transport    │  │  handler       │  └──────────┬─────────┘ │
│   └───────────────────────────┘  └────────┬───────┘             │           │
│                                            │                    │           │
│                              ┌─────────────▼─────────────┐      │           │
│                              │   src/mcp/slack-blocks.js │      │           │
│                              │   buildBlocks(question)   │      │           │
│                              └──────────────┬────────────┘      │           │
│                                              │                  │           │
│   ┌───── @slack/bolt App ──────────────┐  ┌─▼──────────────┐    │           │
│   │  app.event('message'…) ──existing──│  │ src/mcp/       │    │           │
│   │  app.event('app_mention'…)         │  │ poster.js      │    │           │
│   │  app.action('ask_user:*') ─NEW──── │──│ post / open   ─┘    │           │
│   │  app.view  ('ask_user:*') ─NEW──── │  │ modal / update │     │           │
│   └────────────────────────────────────┘  └────────────────┘     │           │
│                                                                  │           │
│   socket.js _setupListeners adds wiring → wireSlackInteractions(app)         │
│   on action/view payload → look up requestId → resolvePending(answer)        │
└──────────────────────────────────────────────────────────────────────────────┘
                 ▲                                              │
                 │ MCP over HTTP/SSE                            │ Slack WebSocket
                 │ http://127.0.0.1:9999/mcp/<session_id>       │
                 │                                              ▼
   ┌─────────────┴──────────────┐                        ┌──────────────┐
   │  tmux pane (per session)   │                        │   Slack      │
   │  ┌──────────────────────┐  │                        └──────────────┘
   │  │ claude / codex / gem │  │
   │  │  ask_user(...)       │  │
   │  │   ← blocks here →    │  │
   │  └──────────────────────┘  │
   └────────────────────────────┘
```

### Wire details

- **Transport**: HTTP + SSE (the MCP SDK's `StreamableHTTPServerTransport`).
  Endpoint `http://127.0.0.1:<MCP_PORT>/mcp/<tmux_session_id>`. One MCP
  transport instance per session, all sharing the same `ask_user` tool
  registry.
- **Session identity**: each CLI's launch prelude exports
  `MCP_SLACK_ASK_URL=http://127.0.0.1:<port>/mcp/<session_id>` and writes a
  session-scoped MCP config (`.mcp.json` for Claude / `--config` for
  Codex / `~/.gemini/settings.json` for Gemini — see Phase 2 below).
- **Pending registry**: in-process `Map<requestId, { resolve, sessionId,
  channel, ts/viewId, timeout, layout, questions }>`. Bot restart loses
  pending state — the agent's tool call errors out; acceptable for a sketch.
- **Slack interactions**: bot subscribes to `block_actions` (button taps)
  and `view_submission` (modal submits). Each action_id / callback_id is
  prefixed `ask_user:<requestId>:...` so routing is a single regex match.

## Phasing — what this PR delivers

This is a **scaffolding PR**. Nothing wires into the running bot yet
(everything gates on `MCP_ENABLED=true`, which defaults to false). Reviewer
can read end-to-end without risk of regression.

**This PR:**

- `src/mcp/server.js` — HTTP MCP server bootstrap (stub; lifts the SDK
  transport but doesn't auto-start).
- `src/mcp/ask-user-tool.js` — tool schema, handler, pending registry,
  `resolvePending()`.
- `src/mcp/slack-blocks.js` — Block Kit renderers for the four primitive
  types + multi-question modal builder (wizard `views.update` path stubbed).
- `src/mcp/poster.js` — Slack `chat.postMessage` / `views.open` wrappers.
- `src/mcp/index.js` — barrel.
- `.env.example` — `MCP_ENABLED`, `MCP_PORT`, `MCP_BIND_HOST`,
  `MCP_DEFAULT_TIMEOUT_MS`.
- `package.json` — `@modelcontextprotocol/sdk` dependency.
- This design doc.

**Phase 2 (follow-up PR):**

- Wire `mcp.startServer()` into `start-slack-socket.js` start-up.
- Wire `wireSlackInteractions(app)` into `socket.js _setupListeners()`.
- Per-adapter `installMcp()` registering the proxy URL with the CLI's
  config layer (Claude / Codex / Gemini).
- Tmux prelude exports `MCP_SLACK_ASK_URL` per session.
- System-prompt nudge: "prefer `slack-ask:ask_user` over the built-in
  question picker."

**Phase 3 (follow-up PR):**

- Wizard layout (multi-step `views.update`) with branching and Back/Next.
- File attachment fallback for `preview` bodies >2000 chars.
- Telemetry: pending-question count, average resolve latency.

## Open questions for review

1. **Endpoint sharing**: do we run the MCP HTTP server on the existing
   Express port (`SLACK_HTTP_PORT`, default 9999) or a dedicated
   `MCP_PORT`? Same port keeps firewall rules simple; dedicated port
   makes it easier to bind 127.0.0.1-only for MCP while exposing Swagger
   on 0.0.0.0.
2. **Session-id leakage**: should `MCP_SLACK_ASK_URL` include the session
   id in the path (cleartext on the tmux pane env) or as a bearer token
   header? 127.0.0.1-only mitigates the risk but tokens are tidier.
3. **System-prompt nudge vs `PreToolUse` redirect**: for Claude we can
   *additionally* deny `AskUserQuestion` via `PreToolUse` and surface a
   message "use slack-ask:ask_user instead". Belts and braces, or
   unnecessary?
4. **Multi-question shorthand**: do we keep the single-question fields
   on the top-level `ask_user` input (current sketch), or always require
   `questions[]`? Single-question shorthand is friendlier; multi-shape is
   more uniform.
