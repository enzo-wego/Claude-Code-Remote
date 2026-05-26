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

The input is uniform: **always** an array `questions[]`, even for a single
question. The return is always `{answers, status}` keyed by `question.id`.
This keeps the wizard layout from being a special case and makes the schema
the agent sees consistent across CLIs.

```typescript
ask_user(input: {
  questions: Array<{
    id?:      string   // result key. Auto-generated if omitted.
    type:     "select" | "confirm" | "text" | "preview"
    question: string

    // select
    options?:     { label: string, description?: string, value?: string }[]
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

    // wizard branching
    show_if?: { question_id: string, equals?: string, in?: string[] }
  }>

  title?:        string                                          // modal title
  submit_label?: string                                          // defaults to "Submit"
  layout?:       "auto" | "single" | "single_modal" | "wizard"   // default: auto
  timeout_ms?:   number                                          // default 1_800_000 (30 min)
}) -> {
  answers: Record<string /* question id */, string | string[]>
  status:  "ok" | "cancelled" | "timeout"
}
```

A one-question call is just `{ questions: [{ id: "scope", type: "select", … }] }`
and reads back as `result.answers.scope`.

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
- **Session identity**: each CLI launch receives session-scoped env and uses
  its native MCP config surface: Claude gets a session-scoped `.mcp.json`,
  Codex gets a per-launch `-c mcp_servers.slackask.url=...` override, and
  Gemini uses a global `~/.gemini/settings.json` URL template.
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

**Phase 2:**

- Wire `mcp.startServer()` into `start-slack-socket.js` start-up.
- Wire `wireSlackInteractions(app)` into `socket.js _setupListeners()`.
- **Gemini**: Global configuration in `~/.gemini/settings.json` via the `mcpServers` key. Uses Strategy A (HTTP with environment variable expansion in the URL) to support concurrent sessions with a single global entry. The tool is exposed as `mcp__slack-ask__ask_user`.
- **Codex**: Per-launch configuration via
  `-c mcp_servers.slackask.url=http://127.0.0.1:<port>/mcp/<session>`.
  Codex uses its native streamable HTTP MCP transport. The tool is exposed as
  `mcp__slackask__.ask_user`.
- System-prompt nudge: "prefer `slack-ask:ask_user` over the built-in
  question picker."

**Phase 3 (follow-up PR):**

- Wizard layout (multi-step `views.update`) with branching and Back/Next.
- File attachment fallback for `preview` bodies >2000 chars.
- Telemetry: pending-question count, average resolve latency.

## Decisions

Resolved before Phase 2 starts (was: Open questions in the original draft):

1. **Endpoint** — Dedicated `MCP_PORT` (default `9998`), bound to `127.0.0.1`.
   The bot's existing Express port (`SLACK_HTTP_PORT`, default `9999`) stays
   on `0.0.0.0` for Swagger/health. No firewall config is needed either way
   since MCP never reaches the network; the separation is purely for bind-host
   isolation and to keep the option of moving MCP to a separate process later
   without breaking URLs.
2. **Session id transport** — In the URL path: `http://127.0.0.1:9998/mcp/<session_id>`.
   The 127.0.0.1 bind means only same-host processes can hit the endpoint;
   on a single-tenant host (VPS, MacBook) that's sufficient. **Caveat for
   multi-tenant hosts**: any local user can read another user's
   `MCP_SLACK_ASK_URL` via `/proc/<pid>/environ` and impersonate the session.
   If we ever deploy to a shared host, swap to a bearer token in an
   `Authorization` header.
3. **Built-in picker redirect** — Phase 2 ships with a system-prompt nudge
   only ("prefer `slack-ask:ask_user` over the built-in picker"). The
   `PreToolUse` deny-with-reason for Claude's `AskUserQuestion` is documented
   below as an optional Phase 3 hardening, applied only if we observe the
   agent ignoring the nudge in practice (e.g. after a context compaction
   wipes the prompt).
4. **Schema shape** — Always `questions[]`, no single-question shorthand.
   The return is always `{answers, status}` keyed by `question.id`. Slightly
   more verbose for one-question calls but eliminates the wizard layout as
   a special case and gives the agent one consistent schema across CLIs.

### Phase 3 optional: PreToolUse deny for Claude

If the system-prompt nudge proves unreliable, add this to
`~/.claude/settings.json` via the Claude adapter's `installHooks()`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [{
          "type": "command",
          "command": "<abs-path>/cli-hook-notify.js deny_ask_user_question"
        }]
      }
    ]
  }
}
```

And a new mode in `cli-hook-notify.js` that writes a deny payload to stdout:

```js
case 'deny_ask_user_question':
    process.stdout.write(JSON.stringify({
        decision: 'deny',
        reason:
            'You are running inside Claude-Code-Remote (Slack relay). The ' +
            'AskUserQuestion picker is rendered in tmux, which the remote ' +
            'Slack user cannot see. Use the `slack-ask:ask_user` MCP tool ' +
            'instead — same shape, but delivered to Slack as Block Kit and ' +
            'returns the user\'s answer as the tool result.',
    }));
    process.exit(0);
```

Codex and Gemini don't have an equivalent hook for their question tools
(see openai/codex#9926), so this remains Claude-only.
