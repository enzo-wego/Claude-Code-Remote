# Claude Code built-in slash commands over Slack

How every Claude Code built-in slash command behaves when injected headlessly
into a tmux pane, and what the bot does with each. Classification comes from
an **empirical survey of Claude Code 2.1.198** (2026-07-02): a scratch tmux
session driven exactly the way the bot injects (paste-buffer + one Enter),
with pane captures after every command. Captures lived in the session
scratchpad (`cmd-survey/caps*`); re-run the survey after major CLI upgrades —
command shapes change between versions (e.g. `/agents` was a wizard, now a
printed notice; `/todos` no longer exists).

## Why built-in local commands need special handling

A Claude Code slash command falls into one of two runtime shapes:

- **Turn-starting** — behaves like a prompt (`/init`, `/review`, custom
  skills). A real assistant turn runs, the `Stop` hook fires, and
  `cli-hook-notify.js` posts the reply to Slack. The generic inject path
  handles these correctly — no changes needed.
- **Local** — handled inside the TUI (`/model`, `/cost`, `/context`, …). No
  turn starts and **no Stop hook fires**, so with the generic path the Slack
  user gets silence. Worse: `_injectCommand` presses Enter up to 7 times
  until it sees a working indicator, and local commands never show one — if
  the command opened a selection dialog, each retry Enter *selects the
  highlighted entry*. That is how a bare `/model` sent from Slack silently
  rewrote the owner's default model (thread `1782958060.862869`, 2026-07-02:
  the picker highlights the current model and its footer reads "Enter to set
  as default").

The fix (in `src/channels/slack/socket.js`): local commands are intercepted
in `_processCommand` before any generic injection, and driven by
`_injectLocalCommand` — paste-verify, **exactly one Enter**, capture — with
per-class post-processing. Claude's command classification lives in
`socket.js`; other CLIs expose their local command sets from their adapter
(`src/cli/codex-adapter.js`, etc.). Commands that start a real assistant turn
still pass through the generic injector so the CLI completion hook posts the
real response.

## Classification (Claude Code 2.1.198)

### `/model` — dedicated handler (`_handleModelCommand`)

| Form | Observed behavior | Bot behavior |
|---|---|---|
| `/model` | Opens interactive picker; "Enter to set as default · s to use this session only · Esc to cancel" | Never injected. Bot replies with the current model (parsed from the pane footer) + usage hint |
| `/model sonnet` | Inline: `Set model to Sonnet 5 and saved as your default for new sessions`. Mid-conversation it first pops a "Switch model?" cache-invalidation confirm (1. Yes / 2. No) | Injected via `_injectLocalCommand`; the confirm dialog is auto-approved (`1` + Enter); the CLI's confirmation line is posted to Slack |
| `/model bogus` | Inline error: `Model 'bogus' not found` — no picker | Error line posted to Slack |

Notes: the inline form **also saves the choice as the user's default for new
sessions** — the posted confirmation says so verbatim. Restricted (non-owner)
users are refused. Codex/Gemini sessions get "not supported — /exit and
relaunch" (their `/model` is picker-only; `supportsModelSwitch: false` on the
adapter).

### Read-only panels — injected, scraped, posted, closed with Esc

These open an interactive panel; the bot captures the panel content, posts it
to Slack as a code block, then sends Esc so no modal is left eating the next
inject's paste. Owner-only (panels expose account/host details).

| Command | Panel content |
|---|---|
| `/cost` | Settings dialog, Usage tab: session cost, per-model usage, limit bars |
| `/usage` | Same dialog/tab as `/cost` |
| `/status` | Version, session id, account, model, MCP summary |
| `/help` | Shortcuts + command help |
| `/mcp` | MCP server list with connect/auth state |
| `/permissions` | Allow/Ask/Deny rule lists |
| `/hooks` | Configured hooks (read-only menu) |
| `/config` | Settings list |
| `/doctor` | Diagnostics report |
| `/bashes` | Background task list |

### Inline prints — injected, output scraped from below the command echo

| Command | Notes |
|---|---|
| `/context` | Context-usage grid + per-category breakdown |
| `/agents` | Prints a deprecation notice (the wizard was removed) |
| `/compact` | Can spin for minutes on a fat context — the bot polls working indicators (up to 3 min) before scraping. Empty conversation prints `Not enough messages to compact.` |
| `/clear` | Produces no output; the bot posts a "conversation cleared" confirmation |

### Blocked — never injected, user gets the reason

Stateful/interactive dialogs that cannot be driven headlessly, or host-side
actions that make no sense from Slack:

| Command | Why blocked |
|---|---|
| `/resume` | Session picker — would switch the pane to another conversation. The bot already resumes automatically when tmux dies |
| `/rewind` | Rewind picker — can restore older conversation/code state |
| `/memory` | Interactive memory editor |
| `/export` | Export-method picker (clipboard/file) |
| `/theme` | Theme picker; meaningless over Slack |
| `/add-dir` | Interactive directory prompt |
| `/login` | OAuth flow needing a browser on the host |
| `/logout` | Would de-authenticate every session on the host |
| `/ide` | **Side-effects immediately** — installed a VS Code extension the moment it ran in the survey |
| `/vim` | Toggles TUI input mode — would break subsequent injection |
| `/terminal-setup`, `/install-github-app`, `/statusline`, `/keybindings` | Host-machine configuration |

### Already special-cased elsewhere

| Command | Handling |
|---|---|
| `/exit`, `/quit`, `/stop` | Session teardown (`EXIT_COMMANDS` in `_processCommand`) |

## Codex CLI local commands over Slack

Codex CLI `0.142.5` has the same headless constraint: local TUI commands do
not start an assistant turn, so the Codex Stop hook will not post anything.
The Codex adapter marks these safe local commands as bot-side:

| Command | Bot behavior |
|---|---|
| `/help`, `/status`, `/usage`, `/mcp`, `/diff` | Inject once, scrape visible output, post it to Slack |
| `/compact` | Inject once, wait for working indicators to clear, scrape visible output |
| `/clear` | Inject once; if no visible output appears, post a local confirmation |
| `/model` | Never injected; Codex's picker is interactive, so the bot tells the user to `/exit` and relaunch with the desired model |

These Codex commands are blocked from Slack because they need host-side auth,
session-pickers, or saved-session mutation outside the current thread:
`/login`, `/logout`, `/resume`, `/fork`, `/archive`, `/delete`,
`/unarchive`, `/new`.

### Pass-through (turn-starting — completion hook posts the reply)

`/init`, `/review`, `/security-review`, `/pr-comments`, `/btw`, and every
custom skill / plugin command (`/pay-ops-production`, …). For Codex this also
includes turn-starting commands such as `/review` and every installed skill or
plugin command. Unknown commands print `Unknown command: /x` locally — the CLI
starts no turn, so the thread stays silent until the inflight watchdog reports;
acceptable, since the command echo message ("Sent `/x` to the session") is
still posted.

## Where the code lives

- `src/channels/slack/socket.js` — `CLAUDE_PANEL_COMMANDS` /
  `CLAUDE_PRINT_COMMANDS` / `CLAUDE_BLOCKED_COMMANDS` (module top), generic
  intercept in `_processCommand`, `_handleModelCommand`,
  `_handleCliLocalCommand`, `_injectLocalCommand`,
  `_scrapeLocalCommandResult`.
- `src/cli/claude-adapter.js` — `supportsModelSwitch: true`,
  `modelSwitchConfirmRegex`.
- `src/cli/codex-adapter.js` — `supportsModelSwitch: false`,
  `localSlashCommands`.
- `src/cli/gemini-adapter.js` — `supportsModelSwitch: false`.
