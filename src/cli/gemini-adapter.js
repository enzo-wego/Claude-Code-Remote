/**
 * Gemini CLI adapter (@google/gemini-cli).
 *
 * Hooks live in ~/.gemini/settings.json under the `hooks` key with the same
 * JSON shape as Claude's settings.json (matcher + hooks array of
 * {type, command, timeout}). Lifecycle events used:
 *   - SessionStart  → captures session_id (analog of Claude's SessionStart)
 *   - AfterAgent    → fires on each turn-final assistant response
 *                     (analog of Claude's Stop hook)
 *
 * The shared cli-hook-notify.js script normalizes Gemini's AfterAgent payload
 * (`prompt_response` → `last_assistant_message`) so the rest of the pipeline
 * stays CLI-agnostic.
 *
 * Footer convention: stats footer for Gemini sessions shows only the model
 * string ("Auto (Gemini 3)") — no Ctx/In/Out — see extractGeminiSessionStats
 * in cli-hook-notify.js and the gemini branch in socket.js poller.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const GEMINI_HOME = path.join(os.homedir(), '.gemini');
const SETTINGS_PATH = path.join(GEMINI_HOME, 'settings.json');
const HOOK_MARKERS = ['cli-hook-notify', 'claude-hook-notify'];
// Gemini's settings.json `timeout` is in MILLISECONDS — the existing
// agent-mem entries in the same file use values like 2000 / 5000ms, and
// the original `15` here was being interpreted as 15ms, killing the hook
// before the Slack API call could complete (TUI showed
// "Hook(s) [...] failed for event AfterAgent" while Slack got nothing).
// Claude's settings.json uses seconds for the same field, so the Claude
// adapter's `15` is correct there. 30 seconds = 30000 here.
const HOOK_TIMEOUT_MS = 30000;

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
    if (!fs.existsSync(GEMINI_HOME)) fs.mkdirSync(GEMINI_HOME, { recursive: true });
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
        hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_MS }]
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

module.exports = {
    type: 'gemini',

    supportsAskUser: true,
    askUserGuidance() {
        return [
            '[INTERACTIVE QUESTIONS — IMPORTANT]',
            'When you need to ask the user a clarifying question or have them',
            'pick from options, invoke the MCP tool `mcp__slack-ask__ask_user`',
            '(it appears in your tool list with that exact name — it is a regular',
            'MCP tool, NOT a sub-agent). Schema:',
            '',
            '  mcp__slack-ask__ask_user({',
            '    questions: [',
            '      { id: "scope", type: "select", question: "Which scope?",',
            '        options: [{label:"a", value:"a"}, {label:"b", value:"b"}] }',
            '    ]',
            '  })',
            '',
            'Returns { answers: { <id>: <value> }, status: "ok" }. Use this any',
            'time you need a Slack-side response from the user.',
            '',
            '',
        ].join('\n');
    },

    // --yolo  : auto-approve tools (Claude --dangerously-skip-permissions analog).
    // --skip-trust : bypass first-run "Trust folder?" numbered-choice modal.
    buildLaunchCommand(/* sessionName, repoPath, sessionKey */) {
        return process.env.GEMINI_COMMAND || 'gemini --yolo --skip-trust';
    },

    // Resume CLI flag isn't yet documented for gemini-cli; falling back to a
    // fresh session keeps behavior safe (caller treats null as "no resume").
    buildResumeCommand(/* sessionId */) {
        return null;
    },

    readinessTimeoutMs: 60000,

    // TUI ready when the input-box placeholder is rendered. Stable substring
    // across versions — the footer also shows "Auto (Gemini 3)" but that text
    // moves around, while the placeholder is anchored to the input row.
    isReady(output) {
        return /Type your message or @/.test(output);
    },

    // Gemini drifts back to GitHub-style `**bold**` / `[label](url)` between
    // turns even after a skill's SKILL.md teaches Slack mrkdwn, so reinforce
    // the rules verbatim on every chat inject. Skill invocations skip this
    // (the SKILL.md is authoritative there) — see _processCommand in
    // src/channels/slack/socket.js.
    chatFormattingGuidance() {
        return [
            '[Slack formatting rules — apply to every Slack message you post in this thread]',
            '- Bold: *bold*  (single asterisk; NOT **bold**)',
            '- Italic: _italic_  (NOT *italic*)',
            '- Strikethrough: ~strike~',
            '- Inline code: `code`',
            '- Code block: ```code```',
            '- Bullet list: prefix each line with "•" or "-"',
            '- Links: <https://example.com|label>  (NOT [label](url))',
            '- No `#` / `##` headings — they print as literal hashes in Slack.',
            'Standard GitHub-flavored markdown is OK ONLY inside attachment files saved to disk; never in the chat message body.',
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

    // Gemini doesn't render a "[Pasted Content N chars]" placeholder — pasted
    // text appears verbatim after the `* ` bullet inside the input box.
    // The literal-first-line fallback in the injector is too strict here:
    // characters at the tail of the paste can get swallowed (e.g. `?` is
    // bound to "open shortcuts" inside the TUI and gets interpreted as a
    // keypress instead of appearing in the box), making `output.includes()`
    // fail even when the paste effectively landed.
    //
    // Match the input row directly: a `* ` bullet followed by any
    // non-whitespace that is NOT the empty-state placeholder
    // (`Type your message or @path/to/file`). The negative lookahead lets us
    // distinguish "user content rendered" from "empty input box".
    pasteLandedIndicators: [/^\s*\*\s+(?!Type your message)\S/m],

    // Gemini's spinner row reads e.g. "⠦ Refining Find Command (esc to cancel, 6s)".
    // "esc to cancel" is the stable working signal (Codex uses "esc to interrupt",
    // Claude rotates verbs + a timer regex). Keep narrow so idle help text
    // doesn't false-match.
    workingIndicators: [
        'esc to cancel'
    ],
    workingRegexes: [],

    // Poller idle-prompt detection. socket.js's shared `hasPrompt` regex only
    // matches `❯`/`>`/`›` style prompts — Gemini renders an empty input row as
    // ` *   Type your message or @path/to/file `, so without an adapter-specific
    // indicator the poller never declares idle and spins until POLLER_TIMEOUT_MS.
    // The placeholder text only appears when the input box is empty (= idle),
    // making it a reliable signal. This is the only fallback when AfterAgent
    // doesn't fire — notably on `Request cancelled.` (safety-guard turn aborts),
    // where the hook is skipped because no turn-final assistant message exists.
    idlePromptIndicators: ['Type your message or @'],

    // Gemini's TUI parks the outer agent on `! Shell awaiting input (Tab to focus)`
    // when a shell tool prompts for stdin OR when --yolo doesn't cover the MAX_TURNS
    // recovery turn. Without auto-handling, the agent stays parked, AfterAgent never
    // fires, and the alert investigation never reaches Slack (root cause of the
    // lost-report incident on Q0OWCEYQW7VRLU). socket.js `_autoApprove` sends Escape
    // on this pattern, which cancels the stuck shell so the agent can finish its
    // turn and fire AfterAgent normally.
    confirmationPrompts: ['Shell awaiting input'],
    handlesConfirmationPrompts: true,

    // No fatal startup banners observed yet. Add as we encounter them.
    fatalErrorPatterns: [],

    installHooks() {
        const settings = loadSettings();
        settings.hooks = settings.hooks || {};
        settings.hooks.SessionStart = settings.hooks.SessionStart || [];
        settings.hooks.AfterAgent = settings.hooks.AfterAgent || [];

        const script = hookScriptPath();
        const quoted = script.includes(' ') ? `"${script}"` : script;
        // Pin to the installer's node binary (same reason as the other adapters):
        // the hook spawns under the pane's shell, where bare `node` may resolve
        // to a different version than the one that compiled better-sqlite3 —
        // ABI mismatch makes the hook exit silently and drops Slack posts.
        const nodeBin = process.execPath;
        const nodeQuoted = nodeBin.includes(' ') ? `"${nodeBin}"` : nodeBin;
        const commands = {
            SessionStart: `${nodeQuoted} ${quoted} session_start`,
            AfterAgent: `${nodeQuoted} ${quoted} completed`,
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
        for (const event of ['SessionStart', 'AfterAgent']) {
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
                AfterAgent: listHasOurHook(hooks.AfterAgent),
            },
        };
    },

    // ─── MCP slack-ask wiring ─────────────────────────────────────────
    //
    // Gemini CLI accepts `mcpServers` under ~/.gemini/settings.json, with
    // stdio AND HTTP transports both supported. Strategy A uses HTTP with
    // environment variable expansion in the URL so a single global entry
    // works for all concurrent sessions.

    installMcp({ sessionKey, mcpServerUrl } = {}) {
        if (!sessionKey || !mcpServerUrl) {
            return { launchFlag: '', launchEnv: {}, configPath: null };
        }

        const settings = loadSettings();
        settings.mcpServers = settings.mcpServers || {};

        // Idempotently add/update the slack-ask server.
        // We use environment variable expansion for the URL.
        settings.mcpServers['slack-ask'] = {
            url: '${CLAUDE_REMOTE_MCP_URL_FULL}',
        };

        saveSettings(settings);

        const base = String(mcpServerUrl).replace(/\/+$/, '');
        return {
            launchFlag: '',
            launchEnv: {
                CLAUDE_REMOTE_SESSION_ID: sessionKey,
                CLAUDE_REMOTE_MCP_URL_FULL: `${base}/${encodeURIComponent(sessionKey)}`,
            },
            configPath: SETTINGS_PATH,
        };
    },

    uninstallMcp() {
        // The entry is global, not per-session — leave it in place (multiple
        // concurrent sessions all read the same file). Return false so the
        // session-teardown caller knows there's nothing to clean.
        return false;
    },
};
