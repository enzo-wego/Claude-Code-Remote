/**
 * Claude CLI adapter — current baseline behaviour.
 * Used for all features unless a per-feature flag opts into Codex.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_MARKERS = ['cli-hook-notify', 'claude-hook-notify'];
const HOOK_TIMEOUT = 15;

// Per-session MCP configs live here so each tmux session points Claude at
// `http://127.0.0.1:<port>/mcp/<session_id>`. We don't write into the repo's
// .mcp.json because multiple sessions may share repoPath.
const MCP_CONFIG_DIR = path.join(os.tmpdir(), 'claude-code-remote-mcp');
const MCP_SAFE_KEY_RE = /[^a-zA-Z0-9_-]/g;

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
    readinessTimeoutMs: 30000,

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
    askUserGuidance() {
        return [
            '[INTERACTIVE QUESTIONS — IMPORTANT]',
            'When you need to ask the user a clarifying question or have them',
            'pick from options, invoke the MCP tool `mcp__slack-ask__ask_user`',
            '(it appears in your tool list with that exact name — it is a regular',
            'MCP tool, NOT a subagent — do not use `<to=team_name=...>` or any',
            'delegation syntax). Schema:',
            '',
            '  mcp__slack-ask__ask_user({',
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
            'mcp__slack-ask__ask_user is the only path that reaches them.',
            '',
            '',
        ].join('\n');
    },

    // Brief Slack mrkdwn reminder prepended to every non-skill chat turn so
    // Claude doesn't default to GitHub-style `**bold**` mid-thread. Skill
    // invocations skip this — SKILL.md is authoritative there. See
    // _processCommand in src/channels/slack/socket.js.
    chatFormattingGuidance() {
        return [
            '[Slack mrkdwn for Slack replies: *bold*, _italic_, ~strike~, `code`, <https://url|label>, "-" or "•" bullets. No `#` / `##` headings — they print as literal hashes. Standard GitHub markdown only inside attachment files.]',
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
    workingIndicators: [
        'brewing', 'clauding', 'flibbertigibbeting', 'esc to interrupt',
        '● skill(', 'crunching', 'metamorphosing', 'burrowing', 'running…', '⏳'
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
        for (const event of ['SessionStart', 'Stop', 'SubagentStop']) {
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
                'slack-ask': {
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

    hooksStatus() {
        const settings = loadSettings();
        const hooks = settings.hooks || {};
        return {
            path: SETTINGS_PATH,
            installed: {
                SessionStart: listHasOurHook(hooks.SessionStart),
                Stop: listHasOurHook(hooks.Stop),
                SubagentStop: listHasOurHook(hooks.SubagentStop),
            },
        };
    },
};
