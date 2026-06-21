/**
 * Claude CLI adapter — current baseline behaviour.
 * Used for all features unless a per-feature flag opts into Codex.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const RUNTIME_FATAL_PATTERNS = require('./runtime-fatal-patterns');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_MARKERS = ['cli-hook-notify', 'claude-hook-notify'];
const HOOK_TIMEOUT = 15;

// Per-session MCP configs live here so each tmux session points Claude at
// `http://127.0.0.1:<port>/mcp/<session_id>`. We don't write into the repo's
// .mcp.json because multiple sessions may share repoPath.
const MCP_CONFIG_DIR = path.join(os.tmpdir(), 'claude-code-remote-mcp');
const MCP_SAFE_KEY_RE = /[^a-zA-Z0-9_-]/g;
// MCP server-name slug used in both the .mcp.json key and the agent-visible
// tool name (`mcp__<server>__ask_user`). Keep aligned with the Gemini adapter
// (same dash-form) — Codex uses its own no-dash form for TOML reasons.
const MCP_SERVER_NAME = 'slack-ask';

function hookScriptPath() {
    const preferred = path.join(REPO_ROOT, 'cli-hook-notify.js');
    if (fs.existsSync(preferred)) return preferred;
    return path.join(REPO_ROOT, 'claude-hook-notify.js');
}

function loadSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveSettings(settings) {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function hookIsOurs(hook) {
    return hook && hook.command && HOOK_MARKERS.some(m => hook.command.includes(m));
}

function listHasOurHook(list) {
    return Array.isArray(list) && list.some(e =>
        Array.isArray(e.hooks) && e.hooks.some(hookIsOurs)
    );
}

function upsertHook(list, command) {
    if (!Array.isArray(list)) list = [];
    if (list.some(e => Array.isArray(e.hooks) && e.hooks.some(h => h.command === command))) {
        return list;
    }
    list.push({
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }]
    });
    return list;
}

function removeOurHooks(list) {
    if (!Array.isArray(list)) return list;
    const filtered = list
        .map(entry => {
            if (!Array.isArray(entry.hooks)) return entry;
            const remaining = entry.hooks.filter(h => !hookIsOurs(h));
            return remaining.length > 0 ? { ...entry, hooks: remaining } : null;
        })
        .filter(Boolean);
    return filtered.length > 0 ? filtered : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
    type: 'claude',
    // Mid-turn fatal errors (missing AWS profile, expired SSO) that the poller
    // escalates on instead of busy-looping until the wall ceiling. See
    // runtime-fatal-patterns.js.
    runtimeFatalPatterns: RUNTIME_FATAL_PATTERNS,

    // True when this adapter's installMcp() actually wires the agent to our
    // slack-ask MCP server. Socket.js gates the askUserGuidance prepend on
    // this flag so we don't nudge the agent to call a tool that isn't there.
    supportsAskUser: true,

    buildLaunchCommand(/* sessionName, repoPath, sessionKey */) {
        const base = process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions';
        // Optional model override appended composably so SLACK_CLAUDE_COMMAND
        // can keep its default. Useful when Opus-with-xhigh-effort gets flaky
        // at calling MCP tools — set SLACK_CLAUDE_MODEL=sonnet-4-6 to pin the
        // bot's spawned Claude sessions to a less aggressive model without
        // touching your interactive Claude config.
        // Whitelist-validate: model strings are alphanumeric, dot, dash, or
        // underscore. Anything else is silently dropped (no shell injection
        // via tmux send-keys).
        const model = process.env.SLACK_CLAUDE_MODEL;
        if (model && /^[A-Za-z0-9._-]+$/.test(model)) {
            return `${base} --model ${model}`;
        }
        return base;
    },

    // Returns the launch command with `--resume <uuid>` appended, or null when
    // the id is malformed. Returning null tells the caller to fall back to
    // buildLaunchCommand (fresh session). UUID is whitelist-validated to keep
    // the eventual `tmux send-keys` shell-safe.
    buildResumeCommand(sessionId) {
        if (!UUID_RE.test(String(sessionId || ''))) return null;
        return `${this.buildLaunchCommand()} --resume ${sessionId}`;
    },

    // How long to wait for the TUI to be ready before injecting the first command.
    // 60s (was 30s) gives a CPU-starved host headroom: on a loaded VPS (load avg
    // > cores) Claude Code's Node + Ink + MCP-handshake startup can exceed 60s,
    // and a 30s budget timed out → the bot pasted into a still-initializing TUI
    // and tcsetattr(TCSAFLUSH) silently flushed every paste (incident 1781303635,
    // process-taxes delay alert, 2026-06-13). Matches the gemini adapter.
    readinessTimeoutMs: 60000,

    // After isReady() matches, wait this long before the first paste so the TUI
    // input handler is fully wired. Without it, a paste fired the instant the ❯
    // prompt renders races the handler init and is dropped. Codex/Gemini already
    // carry an equivalent grace; Claude was the unhardened outlier.
    postReadyGraceMs: 4000,

    // Claude Code shows ) or ❯ or > alone on a line when it's accepting input.
    isReady(output) {
        return /^[)❯>]\s*$/m.test(output);
    },

    // One-line nudge prepended to a fresh-CLI-boot turn when MCP slack-ask
    // is enabled. Tells the agent that AskUserQuestion is unreachable
    // (rendered in tmux, invisible to the Slack user) and to call the
    // slack-ask:ask_user MCP tool instead. See _processCommand in
    // src/channels/slack/socket.js for the prepend logic — gated on the
    // adapter's supportsAskUser flag so Codex/Gemini sessions don't get a
    // nudge to call a tool that isn't wired for them yet.
    askUserToolName() {
        return `mcp__${MCP_SERVER_NAME}__ask_user`;
    },

    askUserGuidance() {
        const tool = this.askUserToolName();
        return [
            '[INTERACTIVE QUESTIONS — IMPORTANT]',
            'When you need to ask the user a clarifying question or have them',
            `pick from options, invoke the MCP tool \`${tool}\``,
            '(it appears in your tool list with that exact name — it is a regular',
            'MCP tool, NOT a subagent — do not use `<to=team_name=...>` or any',
            'delegation syntax). Schema:',
            '',
            `  ${tool}({`,
            '    questions: [',
            '      { id: "scope", type: "select", question: "Which scope?",',
            '        options: [{label:"a", value:"a"}, {label:"b", value:"b"}] },',
            '      { id: "note",  type: "text",   question: "Why?", multiline: true },',
            '      { id: "go",    type: "confirm", question: "Proceed?" }',
            '    ]',
            '  })',
            '',
            'Returns { answers: { scope, note, go }, status: "ok" }. The built-in',
            'AskUserQuestion picker renders in a TUI the Slack user cannot see;',
            `${tool} is the only path that reaches them.`,
            '',
            '',
        ].join('\n');
    },

    // One-line repeat reminder prepended to every later chat turn (the full
    // schema above is taught once on the boot turn). Cheap enough to repeat:
    // it just re-points the model at the MCP tool — whose full schema is
    // already in its tool list — so a built-in AskUserQuestion picker (invisible
    // to the Slack user) is never reached on a turn that missed the boot nudge.
    askUserReminder() {
        const tool = this.askUserToolName();
        return `[To ask the user anything, call the MCP tool \`${tool}\` — NOT the built-in AskUserQuestion picker, which renders in a TUI the Slack user cannot see.]\n\n`;
    },

    // Brief Slack mrkdwn reminder prepended to every non-skill chat turn so
    // Claude doesn't default to GitHub-style `**bold**` mid-thread. Skill
    // invocations skip this — SKILL.md is authoritative there. See
    // _processCommand in src/channels/slack/socket.js.
    chatFormattingGuidance() {
        return [
            '[Slack mrkdwn for Slack replies: *bold*, _italic_, ~strike~, `code`, <https://url|label>, "-" or "•" bullets. No `#` / `##` headings — they print as literal hashes. Standard GitHub markdown only inside attachment files.]',
            '[To attach a file to the Slack thread (reports, logs, dumps, scripts): save it to disk, then put `Attachment written: <absolute path>` on its own line in your reply — it is uploaded automatically. Never paste long file contents inline.]',
            '',
            '',
        ].join('\n');
    },

    buildAlertPrompt({ skill, permalink, fallbackText = '', imageInstruction = '', fallbackIntro = 'Investigate this alert' } = {}) {
        const snippet = (fallbackText || '').substring(0, 500);
        if (skill && permalink) {
            return `execute ${skill} skill with argument ${permalink}${imageInstruction}`;
        }
        if (skill) {
            return `execute ${skill} skill with argument Alert: ${snippet}${imageInstruction}`;
        }
        if (permalink) {
            return `${fallbackIntro}: ${permalink}${imageInstruction}`;
        }
        return `${fallbackIntro}: ${snippet}${imageInstruction}`;
    },

    // Patterns the bracketed-paste handler renders into the pane on success.
    // _injectCommand checks these to confirm a paste actually landed before
    // sending Enter. Claude shows "[Pasted text +N lines]" for multi-line input.
    pasteLandedIndicators: [/Pasted text/i],

    // Substrings checked (case-insensitive) against tmux output to detect "the CLI is busy".
    // Used both by _injectCommand (paste/Enter verification) and by _pollForResponse.
    // Generic English words ('thinking', 'working', 'processing') are deliberately
    // omitted — they false-match in answer bodies (e.g. "blocking re-processing"
    // → matches 'processing' → poller stuck working=true forever, never flushes).
    // The timer regex below is the reliable signal; verbs only catch the brief
    // window before the first `· ↑/↓ N tokens` chunk renders.
    // Transcript lines that persist after a turn ends (e.g. '● Skill(…)') must
    // also stay out — a finished turn's residue in the pane made _injectCommand
    // skip its Enter retries and leave a prompt unsent (incident 2026-06-10).
    workingIndicators: [
        'brewing', 'clauding', 'flibbertigibbeting', 'esc to interrupt',
        'crunching', 'metamorphosing', 'burrowing', 'running…', '⏳'
    ],

    // Extra regexes evaluated against lowercased tail text. Claude Code renders a
    // per-turn timer like "(54s · ↑ 12 tokens)" or "(3m 59s · ↓ 10.5k tokens)"
    // that always shows while the agent is active — a reliable signal even when
    // the verb words rotate. Past 60s the timer switches to space-separated
    // units ("1m 23s", "1h 5m 12s"), so the regex must accept one-or-more
    // `<digits><h|m|s>` groups separated by whitespace.
    workingRegexes: [
        /\((?:\d+[hms]\s*)+·\s+[↑↓]/
    ],

    // Substrings that indicate the CLI is waiting for numbered-choice / yes-no confirmation.
    confirmationPrompts: [
        'Do you want to proceed?',
        '(y/n)',
        '1. Yes'
    ],

    // Patterns that indicate the CLI is stalled and can't continue without
    // user intervention. When matched, the poller pings the owner in the
    // Slack thread so they can unblock (e.g. by sending /compact).
    stalledPatterns: [
        {
            regex: /Context limit reached/i,
            reason: 'context_limit',
            hint: 'Claude hit its context limit. Send `/compact` to compact the conversation, or `/clear` to start fresh.',
        },
        {
            // Claude's API credentials expired/revoked mid-session. The CLI
            // prints `● Please run /login · API Error: 401 Invalid authentication
            // credentials` and freezes: no Stop hook fires, every injected
            // command 401s, so the chain (claude ↔ tmux ↔ bot ↔ Slack) hangs
            // silently. `/login` is an interactive OAuth flow the bot can't
            // drive over tmux, so we can only surface it — the owner must
            // re-auth on the host (attach to the tmux session and run /login).
            //
            // liveTailLines: only match in the bottom N lines of the pane. A
            // live freeze sits just above the input box; once the owner runs
            // /login the recovery output pushes the error up into scrollback,
            // where matching it would be a false positive on already-resolved
            // history. clearedRegex: extra guard for the brief window right
            // after /login where both the error and "Login successful" still
            // share the tail — that's resolved, so don't fire.
            regex: /Please run \/login|API Error: 401[^\n]*Invalid authentication credentials/i,
            liveTailLines: 25,
            clearedRegex: /Login successful/i,
            reason: 'auth_401',
            hint: 'Claude needs re-authentication (API Error: 401 — credentials expired/revoked). The session is frozen and can\'t accept commands until you re-login. SSH to the host, `tmux attach` to this session, and run `/login`.',
        }
    ],

    // Whether _injectCommand + poller should auto-approve confirmation dialogs.
    handlesConfirmationPrompts: true,

    installHooks() {
        const settings = loadSettings();
        settings.hooks = settings.hooks || {};
        settings.hooks.SessionStart = settings.hooks.SessionStart || [];
        settings.hooks.Stop = settings.hooks.Stop || [];
        settings.hooks.SubagentStop = settings.hooks.SubagentStop || [];
        settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

        const script = hookScriptPath();
        const quoted = script.includes(' ') ? `"${script}"` : script;
        // Pin to the absolute path of the node binary running this installer so
        // hooks can't pick up a different node from the user's PATH at runtime.
        // Claude Code spawns hook commands via the pane's shell, where `node`
        // may resolve to a newer version than the one that compiled
        // better-sqlite3 — the require() throws ABI-mismatch and the hook
        // exits silently, dropping every Slack notification.
        const nodeBin = process.execPath;
        const nodeQuoted = nodeBin.includes(' ') ? `"${nodeBin}"` : nodeBin;
        const commands = {
            SessionStart: `${nodeQuoted} ${quoted} session_start`,
            Stop: `${nodeQuoted} ${quoted} completed`,
            SubagentStop: `${nodeQuoted} ${quoted} waiting`,
            UserPromptSubmit: `${nodeQuoted} ${quoted} prompt-submitted`,
        };

        let changed = false;
        for (const [event, command] of Object.entries(commands)) {
            const before = JSON.stringify(settings.hooks[event] || []);
            settings.hooks[event] = upsertHook(settings.hooks[event], command);
            if (JSON.stringify(settings.hooks[event]) !== before) changed = true;
        }

        if (changed) saveSettings(settings);
        return { path: SETTINGS_PATH, changed, commands };
    },

    uninstallHooks() {
        const settings = loadSettings();
        if (!settings.hooks) return { path: SETTINGS_PATH, changed: false };
        let changed = false;
        for (const event of ['SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']) {
            if (listHasOurHook(settings.hooks[event])) {
                settings.hooks[event] = removeOurHooks(settings.hooks[event]);
                if (!settings.hooks[event]) delete settings.hooks[event];
                changed = true;
            }
        }
        if (changed) saveSettings(settings);
        return { path: SETTINGS_PATH, changed };
    },

    // ─── MCP slack-ask wiring ─────────────────────────────────────────
    //
    // Write a session-scoped `.mcp.json`-style config that Claude reads via
    // its `--mcp-config <file>` launch flag. The flag must be appended to
    // the launch command by the caller (socket.js, Phase 2 Step 4).
    //
    // Generates: ${tmpdir}/claude-code-remote-mcp/claude-<safeKey>.json
    // Returns:   { launchFlag, configPath } — launchFlag is empty when MCP
    //            is disabled / args missing, so callers can unconditionally
    //            concat without guarding.

    installMcp({ sessionKey, mcpServerUrl } = {}) {
        if (!sessionKey || !mcpServerUrl) {
            return { launchFlag: '', configPath: null };
        }
        if (!fs.existsSync(MCP_CONFIG_DIR)) {
            fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });
        }
        const safeKey = String(sessionKey).replace(MCP_SAFE_KEY_RE, '_');
        const configPath = path.join(MCP_CONFIG_DIR, `claude-${safeKey}.json`);
        const base = String(mcpServerUrl).replace(/\/+$/, '');
        const config = {
            mcpServers: {
                [MCP_SERVER_NAME]: {
                    type: 'http',
                    url: `${base}/${encodeURIComponent(sessionKey)}`,
                },
            },
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return {
            launchFlag: `--mcp-config "${configPath}"`,
            launchEnv: {},
            configPath,
        };
    },

    uninstallMcp({ sessionKey } = {}) {
        if (!sessionKey) return false;
        const safeKey = String(sessionKey).replace(MCP_SAFE_KEY_RE, '_');
        const configPath = path.join(MCP_CONFIG_DIR, `claude-${safeKey}.json`);
        try {
            fs.unlinkSync(configPath);
            return true;
        } catch {
            return false;
        }
    },

    // Counterpart to uninstallMcp. Claude uses a per-session file model, so
    // there is no shared global config to remove — per-session uninstall is
    // automatic via `_deleteSession` in socket.js. Returning a structured
    // result keeps mcp-manage.js output consistent across adapters.
    uninstallMcpGlobal() {
        return { changed: false, reason: 'per-session model — no global state to clean' };
    },

    hooksStatus() {
        const settings = loadSettings();
        const hooks = settings.hooks || {};
        return {
            path: SETTINGS_PATH,
            installed: {
                SessionStart: listHasOurHook(hooks.SessionStart),
                Stop: listHasOurHook(hooks.Stop),
                SubagentStop: listHasOurHook(hooks.SubagentStop),
                UserPromptSubmit: listHasOurHook(hooks.UserPromptSubmit),
            },
        };
    },
};
