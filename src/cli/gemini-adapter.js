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

module.exports = {
    type: 'gemini',

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
    // text appears verbatim in the input box. Empty array forces the injector
    // to fall through to its first-line literal-substring check (instead of
    // the default Claude regex, which wouldn't match here).
    pasteLandedIndicators: [],

    // Gemini's spinner row reads e.g. "⠦ Refining Find Command (esc to cancel, 6s)".
    // "esc to cancel" is the stable working signal (Codex uses "esc to interrupt",
    // Claude rotates verbs + a timer regex). Keep narrow so idle help text
    // doesn't false-match.
    workingIndicators: [
        'esc to cancel'
    ],
    workingRegexes: [],

    confirmationPrompts: [],
    handlesConfirmationPrompts: false,

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
};
