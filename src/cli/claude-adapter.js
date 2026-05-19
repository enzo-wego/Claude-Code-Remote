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

    buildLaunchCommand(/* sessionName, repoPath, sessionKey */) {
        return process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions';
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
