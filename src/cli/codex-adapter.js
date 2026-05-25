/**
 * Codex CLI adapter.
 *
 * Uses Codex's native hooks system (https://developers.openai.com/codex/hooks):
 * hooks live in ~/.codex/hooks.json with the same JSON shape as Claude's
 * settings.json. We register a `Stop` hook that calls cli-hook-notify.js on
 * turn completion — the payload (stdin JSON: session_id, turn_id,
 * last_assistant_message, transcript_path) mirrors Claude's Stop hook, so the
 * shared notify script handles both CLIs.
 *
 * Requires `[features] codex_hooks = true` in ~/.codex/config.toml — checked
 * at install time.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CODEX_HOME = path.join(os.homedir(), '.codex');
const HOOKS_PATH = path.join(CODEX_HOME, 'hooks.json');
const CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
const HOOK_MARKERS = ['cli-hook-notify', 'claude-hook-notify'];
const HOOK_TIMEOUT = 15;

function hookScriptPath() {
    const preferred = path.join(REPO_ROOT, 'cli-hook-notify.js');
    if (fs.existsSync(preferred)) return preferred;
    return path.join(REPO_ROOT, 'claude-hook-notify.js');
}

function loadHooks() {
    if (!fs.existsSync(HOOKS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveHooks(doc) {
    if (!fs.existsSync(CODEX_HOME)) fs.mkdirSync(CODEX_HOME, { recursive: true });
    fs.writeFileSync(HOOKS_PATH, JSON.stringify(doc, null, 2));
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
    // Remove any stale copies of our hook (either script name) before adding the
    // canonical one. Prevents duplicate posts across rename/reinstalls.
    list = removeOurHooks(list) || [];
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

// codex_hooks is a Codex feature gate — hooks.json is ignored unless set.
function codexHooksFeatureEnabled() {
    if (!fs.existsSync(CONFIG_PATH)) return false;
    try {
        return /codex_hooks\s*=\s*true/.test(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return false;
    }
}

// Idempotently set `codex_hooks = true` under `[features]` in config.toml.
// Returns true if the file was changed. We use a regex-based merge instead of
// a TOML parser to preserve comments and ordering of unrelated keys — the bot
// is the only thing touching this flag, and the format is stable enough.
function enableCodexHooksFeature() {
    let body = '';
    if (fs.existsSync(CONFIG_PATH)) {
        try { body = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { body = ''; }
    }
    if (/codex_hooks\s*=\s*true/.test(body)) return false;

    let next;
    if (/codex_hooks\s*=\s*false/.test(body)) {
        next = body.replace(/codex_hooks\s*=\s*false/, 'codex_hooks = true');
    } else if (/^\s*\[features\]\s*$/m.test(body)) {
        // Insert immediately after the [features] header
        next = body.replace(/^(\s*\[features\]\s*)$/m, `$1\ncodex_hooks = true`);
    } else {
        const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
        next = body + `${sep}\n[features]\ncodex_hooks = true\n`;
    }

    if (!fs.existsSync(CODEX_HOME)) fs.mkdirSync(CODEX_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, next);
    return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
    type: 'codex',

    // installMcp() is currently a stub; do not nudge the agent to call a
    // tool that isn't wired. Will flip to true when the stdio MCP proxy
    // for Codex lands (see docs/mcp-ask-user.md Phase 3 follow-up).
    supportsAskUser: false,
    askUserGuidance() { return ''; },

    buildLaunchCommand(/* sessionName, repoPath, sessionKey */) {
        return process.env.CODEX_COMMAND || 'codex --dangerously-bypass-approvals-and-sandbox';
    },

    // Build a `codex resume <uuid> [flags]` invocation by splicing the
    // `resume` subcommand after the executable token of CODEX_COMMAND.
    // Codex's `resume` accepts the same global flags as the root command
    // (--dangerously-bypass-approvals-and-sandbox, -c, etc.). Returns null
    // when id is malformed or CODEX_COMMAND can't be parsed — caller falls
    // back to buildLaunchCommand.
    buildResumeCommand(sessionId) {
        if (!UUID_RE.test(String(sessionId || ''))) return null;
        const launch = this.buildLaunchCommand();
        const m = launch.match(/^(\S+)(?:\s+(.*))?$/);
        if (!m) return null;
        const exe = m[1];
        const rest = (m[2] || '').trim();
        return rest ? `${exe} resume ${sessionId} ${rest}` : `${exe} resume ${sessionId}`;
    },

    // Brief Slack mrkdwn reminder prepended to every non-skill chat turn so
    // Codex doesn't default to GitHub-style `**bold**` mid-thread. Skill
    // invocations skip this — SKILL.md is authoritative there. See
    // _processCommand in src/channels/slack/socket.js.
    chatFormattingGuidance() {
        return [
            '[Slack mrkdwn for Slack replies: *bold*, _italic_, ~strike~, `code`, <https://url|label>, "-" or "•" bullets. No `#` / `##` headings — they print as literal hashes. Standard GitHub markdown only inside attachment files.]',
            '',
            '',
        ].join('\n');
    },

    // Mirror Claude's natural-language invocation. Codex skills register via
    // slash commands, but those require an active session (error: "Session
    // expired. /<skill> requires an active session — send a message first").
    // Natural language works as the first message of a new session.
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

    // Codex ready = footer prompt visible AND no MCP boot banner still on-screen.
    // The MCP banner (`• Starting MCP servers (N/M): sonarqube (6s • esc to interrupt)`)
    // contains "esc to interrupt", which collides with real turn activity. A slow MCP
    // server (e.g. sonarqube) can keep this line visible for 30–60s, so the readiness
    // budget is generous.
    readinessTimeoutMs: 90000,

    // After isReady() returns true, wait this long before pasting. Codex prints
    // late banners ("Under-development features enabled", etc.) asynchronously
    // after the prompt is first rendered; a paste that lands during that
    // redraw can end up with the first Enter silently dropped. This grace
    // window lets the TUI settle.
    postReadyGraceMs: 2000,

    isReady(output) {
        if (/Starting MCP servers/.test(output)) return false;
        // Under-development warning is printed asynchronously after MCP boot.
        // Only mark ready once the warning has fully printed AND a blank line
        // separates it from the prompt — otherwise a paste racing the warning
        // redraw can sit unsubmitted in the input box.
        if (/Under-development features enabled/.test(output)
            && !/suppress_unstable_features_warning[^\n]*\n\s*\n/.test(output)) {
            return false;
        }
        return /\n\s*› /.test(output);
    },

    // Working indicators match the *real* turn spinner. Codex shows a leading
    // bullet ("• Thinking…", "• Running tool…") paired with "esc to interrupt"
    // during a live turn. The same "esc to interrupt" text also appears in the
    // MCP-startup banner, so we filter that line out of the detection window
    // (see _pollForResponse in socket.js). Kept deliberately narrow so idle
    // help text ("/review …", "/diff …") doesn't falsely match.
    workingIndicators: [
        'esc to interrupt'
    ],
    workingRegexes: [],

    // Codex collapses bracketed pastes behind a "[Pasted Content N chars]"
    // placeholder, so checking for the literal command text never matches.
    // _injectCommand uses these to confirm the paste landed.
    pasteLandedIndicators: [/\[Pasted Content \d+ chars?\]/i],

    // Lines matching these patterns are stripped from the working-state
    // detection window. Used to suppress the MCP startup banner that would
    // otherwise look like a live turn.
    workingExcludePatterns: [
        /Starting MCP servers/i
    ],

    // Fatal errors that should abort the tmux session immediately so the
    // fallback CLI (if any) can take over. Detected during readiness polling
    // in socket.js — on match, we kill the tmux session and try the next CLI
    // in the configured chain instead of waiting for readinessTimeoutMs.
    fatalErrorPatterns: [
        {
            // ChatGPT Plus / Pro quota exhaustion. Codex prints a banner like:
            //   "You've hit your usage limit. To get more access now, send a
            //    request to your admin or try again at 1:02 PM."
            // No prompt is ever rendered after this, so the session hangs.
            regex: /You['’]ve hit your usage limit/i,
            reason: 'codex usage limit reached',
        },
    ],

    confirmationPrompts: [],
    handlesConfirmationPrompts: false,

    installHooks() {
        const doc = loadHooks();
        doc.hooks = doc.hooks || {};

        const script = hookScriptPath();
        const quoted = script.includes(' ') ? `"${script}"` : script;
        // Pin to the installer's node binary — same reason as in
        // claude-adapter.js: a different `node` on the user's PATH at runtime
        // (e.g. after a Node upgrade) breaks better-sqlite3's native binding
        // and the hook exits silently before posting to Slack.
        const nodeBin = process.execPath;
        const nodeQuoted = nodeBin.includes(' ') ? `"${nodeBin}"` : nodeBin;
        const command = `${nodeQuoted} ${quoted} completed`;

        const before = JSON.stringify(doc.hooks.Stop || []);
        doc.hooks.Stop = upsertHook(doc.hooks.Stop, command);
        const hooksChanged = JSON.stringify(doc.hooks.Stop) !== before;

        if (hooksChanged) saveHooks(doc);

        // hooks.json is silently ignored without this flag — enable it as part
        // of the install instead of just warning, so a one-shot install works.
        const featureChanged = enableCodexHooksFeature();

        return {
            path: HOOKS_PATH,
            changed: hooksChanged || featureChanged,
            command,
            warning: null,
            featureEnabled: true,
        };
    },

    uninstallHooks() {
        const doc = loadHooks();
        if (!doc.hooks || !doc.hooks.Stop) return { path: HOOKS_PATH, changed: false };
        if (!listHasOurHook(doc.hooks.Stop)) return { path: HOOKS_PATH, changed: false };
        doc.hooks.Stop = removeOurHooks(doc.hooks.Stop);
        if (!doc.hooks.Stop) delete doc.hooks.Stop;
        saveHooks(doc);
        return { path: HOOKS_PATH, changed: true };
    },

    hooksStatus() {
        const doc = loadHooks();
        return {
            path: HOOKS_PATH,
            installed: {
                Stop: listHasOurHook(doc.hooks?.Stop),
            },
            featureEnabled: codexHooksFeatureEnabled(),
        };
    },

    // ─── MCP slack-ask wiring ─────────────────────────────────────────
    //
    // STUB — Phase 2 Step 3.
    //
    // Codex's MCP config layer is global (~/.codex/config.toml [mcp_servers.X]
    // blocks) with stdio-only transport. To carry session ids per launch, the
    // intended design is a global `[mcp_servers.slack-ask]` entry that
    // shells a stdio-to-HTTP proxy and reads `CLAUDE_REMOTE_SESSION_ID` from
    // its env at runtime — see docs/mcp-ask-user.md Phase 3 follow-up.
    //
    // For now we expose the contract (matching claude-adapter) but return an
    // empty result. Step 4 calls installMcp on every adapter uniformly; an
    // empty result is a no-op. Codex sessions therefore will NOT route
    // AskUserQuestion-style prompts through Slack until the proxy lands.

    installMcp(/* { sessionKey, mcpServerUrl } */) {
        return { launchFlag: '', launchEnv: {}, configPath: null };
    },

    uninstallMcp(/* { sessionKey } */) {
        return false;
    },
};
