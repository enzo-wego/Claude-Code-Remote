/**
 * Slack Socket Mode Handler
 * Listens for messages via Slack Socket Mode, manages Claude tmux sessions,
 * and relays responses back to Slack threads.
 * Sessions are persisted to SQLite so conversations survive agent restarts.
 */

const { App } = require('@slack/bolt');
const { exec, execSync, execFileSync } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Logger = require('../../core/logger');
const Jobs = require('../../services/jobs');
const PrTasks = require('../../services/pr-tasks');
const AgentSessions = require('../../services/agent-sessions');
const AlertMonitor = require('./alert-monitor');
const DelayAlertMonitor = require('./delay-alert-monitor');
const { AccessControl } = require('./access-control');
const { buildHomeView } = require('./home-tab');
const { buildReviewResultBlocks, handleJobAction } = require('./job-results');
const {
    buildPrDraftResultBlocks,
    titleOf,
} = require('./pr-board');
const { handlePrAction } = require('./pr-actions');
const { extractPrUrls, needsMyReview } = require('../../services/pr-detect');
const {
    fetchPrState,
    fetchTeamMembers,
    fetchViewerLogin,
    fetchViewerTeams,
    refreshAll,
    refreshMine,
    sweepMyPrs,
    sweepReviewRequests,
    sweepTeamPrs,
} = require('../../services/pr-monitor');
const { runDailySummary, parseChannelsConfig } = require('../../services/daily-summary');
const { getCliAdapter, adapterNames } = require('../../cli');
const graphIngest = require('../../graph-ingest');
const { buildContext, handleCommand: graphHandleCommand } = require('../../graph-context');
const { GraphContextConfig } = require('../../graph-context/config');
const { AskerLookup } = require('../../graph-context/asker');
const { GraphClient } = require('../../graph-context/client');

// ─── Credential-honesty directive ──────────────────────────────────────────
//
// Investigations have asserted a token/profile was "expired" without ever
// testing it — on 2026-07-21 (payment p9y0yhtbd5) a session claimed the AWS
// SSO profile was expired when it was actually live, conflating it with a
// genuine BigQuery failure, and buried the (half-wrong) claim in a note to the
// owner. Real expiries are now caught proactively by SsoPrewarm and
// BqHealthMonitor, which DM the owner. This preamble closes the other half:
// forbid the session from *reporting* a credential as down unless a command it
// ran in THIS session shows the failure. Prepended on fresh CLI boots only.
const CREDENTIAL_HONESTY_PREAMBLE = [
    'CREDENTIAL REPORTING RULE (read before investigating):',
    'Do NOT state or imply that any credential, token, AWS profile, gcloud/BigQuery',
    'auth, or SSO session is expired/unavailable/broken unless a command YOU ran in',
    'THIS session produced the actual error. Never infer one credential is dead',
    'because a different one failed — verify each independently before reporting it:',
    '  • AWS: `aws sts get-caller-identity --profile <profile>`',
    '  • BigQuery: `bq query --use_legacy_sql=false "SELECT 1"`',
    'If a check genuinely fails, quote the real error and use the documented',
    'fallback. If you did not test it, do not mention its status at all.',
].join('\n');

// ─── Claude Code built-in LOCAL slash commands ─────────────────────────────
//
// Classification from an empirical survey of Claude Code 2.1.198 driven over
// tmux exactly the way the bot injects (scratch session, paste-buffer + one
// Enter, pane captures — 2026-07-02). These commands run inside the TUI
// without starting an assistant turn, so NO Stop hook fires: the generic
// inject path would post nothing back to Slack and its blind Enter retries
// can "select" entries in any dialog the command opens (a bare /model
// injected that way silently rewrote the owner's default model).
//
// PANEL — opens a read-only interactive panel (Esc closes it). The bot
// injects, scrapes the panel from the pane, posts it, and closes with Esc.
const CLAUDE_PANEL_COMMANDS = new Set([
    '/cost', '/usage', '/status', '/help', '/mcp', '/permissions',
    '/hooks', '/config', '/doctor', '/bashes',
]);
// PRINT — prints its result inline into the transcript, no dialog. The bot
// injects, waits, scrapes everything below the command echo, posts it.
const CLAUDE_PRINT_COMMANDS = new Set([
    '/context', '/agents', '/compact', '/clear',
]);
// BLOCKED — stateful/interactive dialogs that cannot be driven headlessly,
// or host-side actions that make no sense from Slack. Never injected; the
// user gets the reason back. (/model is handled by _handleModelCommand.)
const CLAUDE_BLOCKED_COMMANDS = new Map([
    ['/resume', 'it opens an interactive session picker (the bot resumes sessions automatically when tmux dies)'],
    ['/rewind', 'it opens an interactive picker that can restore older conversation/code state'],
    ['/memory', 'it opens an interactive memory editor — ask the session to edit CLAUDE.md instead'],
    ['/export', 'it opens an interactive export dialog — ask the session to write a file and attach it instead'],
    ['/theme', 'it opens an interactive theme picker, and themes are meaningless over Slack'],
    ['/add-dir', 'it opens an interactive directory prompt — ask the session to read the path instead'],
    ['/login', 'it starts an OAuth flow that needs a browser on the host'],
    ['/logout', 'it would de-authenticate Claude for every session on this host'],
    ['/ide', 'it installs/connects an IDE extension on the host'],
    ['/vim', 'it toggles the TUI input mode, which would break command injection'],
    ['/terminal-setup', 'it reconfigures the host terminal'],
    ['/install-github-app', 'it runs an interactive GitHub app installer'],
    ['/statusline', 'it rewrites the host statusline settings'],
    ['/keybindings', 'it edits host keybindings'],
]);

function _adapterLocalSlashCommand(cliType, firstToken) {
    const token = String(firstToken || '').toLowerCase();
    if (!token.startsWith('/')) return null;

    if ((cliType || 'claude') === 'claude') {
        if (token === '/model') return { type: 'model' };
        const blockedReason = CLAUDE_BLOCKED_COMMANDS.get(token);
        if (blockedReason) return { type: 'blocked', reason: blockedReason };
        if (CLAUDE_PANEL_COMMANDS.has(token)) return { type: 'panel' };
        if (CLAUDE_PRINT_COMMANDS.has(token)) return { type: 'print' };
        return null;
    }

    const adapter = getCliAdapter(cliType);
    const local = adapter.localSlashCommands || {};
    const has = (items) => Array.isArray(items)
        ? items.includes(token)
        : items instanceof Set && items.has(token);
    const blocked = local.blocked || {};
    const blockedReason = blocked instanceof Map ? blocked.get(token) : blocked[token];
    if (blockedReason) return { type: 'blocked', reason: blockedReason };
    if (has(local.panel)) return { type: 'panel' };
    if (has(local.print)) return { type: 'print' };
    return null;
}

// Load graph-context config once at startup (non-fatal if file missing)
let _graphCfg = null;
function _getGraphCfg() {
    if (_graphCfg) return _graphCfg;
    try {
        const cfgPath = process.env.GRAPH_CONTEXT_CONFIG
            || path.join(__dirname, '../../../config/graph-context.yaml');
        _graphCfg = GraphContextConfig.load(cfgPath);
    } catch (err) {
        // Config file missing or malformed — treat as disabled
        _graphCfg = new GraphContextConfig({});
    }
    return _graphCfg;
}

// Singleton asker lookup (5-min TTL cache shared across all handlers)
let _askerLookup = null;
function _getAskerLookup() {
    if (!_askerLookup) _askerLookup = new AskerLookup({});
    return _askerLookup;
}

// Singleton agent-mem graph client for Slack UID -> profile lookups (sender
// identity header). Returns null when AGENT_MEM_GRAPH_URL is unset so the
// resolver silently falls back to Slack users.info. GraphClient's constructor
// requires a baseUrl, so guard before constructing.
let _graphClient = null;
let _graphClientTried = false;
function _getGraphClient() {
    if (_graphClientTried) return _graphClient;
    _graphClientTried = true;
    if (process.env.AGENT_MEM_GRAPH_URL) {
        _graphClient = new GraphClient({
            baseUrl: process.env.AGENT_MEM_GRAPH_URL,
            apiKey: process.env.AGENT_MEM_API_KEY,
        });
    }
    return _graphClient;
}

/**
 * Build a Slack archive URL from team, channel, and thread timestamp.
 * Used as the graph resolve seed.
 */
function _buildSlackArchiveUrl(team, channel, ts) {
    const tsNum = String(ts).replace('.', '');
    return `https://slack.com/archives/${channel}/p${tsNum}`;
}

// Alternation like "claude|codex" derived from registered adapters, so adding a
// new adapter entry auto-enables its keyword in @mention chat regexes below.
const CLI_NAMES_ALT = adapterNames().join('|');
const CLI_KEYWORD_RE = new RegExp(`\\bstart\\s+(${CLI_NAMES_ALT})\\b`, 'i');
const INVESTIGATE_NOW_RE = /\binvestigate\s+(?:it\s+|this\s+)?now\b/i;
// Working-state detection must inspect only the LIVE bottom of the pane, never
// scrollback history. A finished tool-call frame (e.g. `Bash(...)` / `Running…`)
// stays frozen in scrollback and matches `workingIndicators` forever, pinning
// the idle timer open indefinitely (incident 2026-06-22,
// CUV9EAYGY/p1782119465788869: a stale `Running…` 107 lines up kept a session
// alive 13h). The live spinner/timer always renders within the last screenful.
const WORKING_TAIL_LINES = 30;
// Cap on consecutive mid-turn idle-timer rechecks where the pane LOOKS working
// but never changes. A genuine turn mutates the pane every second (token timer,
// spinner); an unchanging "working" tail across this many rechecks is a stale
// indicator, so tear down instead of rescheduling forever.
const MAX_MIDTURN_RECHECKS = 4;
const CLI_PREFIX_GROUP = `(?:(?:${CLI_NAMES_ALT})\\s+)?`;
// Anchored to the start of the message (^\s*): these are explicit commands a
// user types as the whole message, not phrases that may appear mid-sentence.
// Without the anchor, PROJECT_COMMAND_RE's optional "start … from" prefix made
// a bare "project <word>" match anywhere — e.g. "which config files does this
// project read" captured "read" as a project name and reported the bogus path
// /…/read as "Project folder not found".
const ROOT_COMMAND_RE = new RegExp(`^\\s*start\\s+${CLI_PREFIX_GROUP}(?:from|in)\\s+root\\s*$`, 'i');
const PROJECT_COMMAND_RE = new RegExp(`^\\s*(?:start\\s+${CLI_PREFIX_GROUP}(?:from|in)\\s+)?project\\s+(\\S+)(?:\\s+from\\s+root)?`, 'i');
const START_FROM_RE = new RegExp(`^\\s*start\\s+${CLI_PREFIX_GROUP}(?:from|in)\\s+(\\S+?)(?:\\s+project)?\\s*$`, 'i');
// Strips used to remove the CLI/project suffix before sending the prompt to the CLI
const PROJECT_STRIP_RE = new RegExp(`^\\s*(?:start\\s+${CLI_PREFIX_GROUP}(?:from|in)\\s+)?project\\s+\\S+(?:\\s+from\\s+root)?[,.]?\\s*`, 'i');
const START_FROM_STRIP_RE = new RegExp(`^\\s*start\\s+${CLI_PREFIX_GROUP}(?:from|in)\\s+\\S+?(?:\\s+project)?\\s*$`, 'i');
// Matches a leading "resume" / "resume <cli>" / "resume from <X>" / "resume <cli> from <X>"
// so the resumed CLI doesn't see the resume preamble as part of its prompt.
const RESUME_PREFIX_STRIP_RE = new RegExp(
    `^\\s*resume(?:\\s+(?:${CLI_NAMES_ALT}))?(?:\\s+(?:from|in)\\s+\\S+)?\\s*[,.:]?\\s*`,
    'i'
);

class SlackSocketHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('SlackSocket');

        // Polling state per session (in-memory only, rebuilt on start)
        this.pollers = new Map();
        this.sessionTimers = new Map(); // sessionKey -> setTimeout handle
        // sessionKey -> { sig, count }. Tracks consecutive idle-timer rechecks
        // where the pane looked "working" but its live tail never changed, so a
        // stale working indicator can't pin the idle timer open forever.
        this._midTurnRechecks = new Map();
        // sessionKey -> { heartbeat, giveup } timers. Regular @mention replies
        // are delivered solely by cli-hook-notify.js when the CLI fires its Stop
        // hook. If the CLI never cleanly stops (stuck in a long sub-agent, or the
        // tmux/process is torn down first) no hook fires and the thread gets total
        // silence. This watchdog turns that silent failure into a visible notice.
        this._inflightWatchdogs = new Map();
        this._serializedCliLaunches = new Map(); // cliType -> Promise tail
        // sessionKey -> inject-failure retry count for alert sessions whose CLI
        // chain is exhausted. A paste-never-landed failure on the last CLI in
        // the chain is the startup-race signature (host CPU starvation), which a
        // fresh tmux run after a short delay can recover. PagerDuty alerts have
        // the alert_queue requeue for this; delay alerts bypass the queue, so
        // without this they were a silent drop (incident 1781303635, 2026-06-13).
        this._alertInjectRetries = new Map();

        this.app = new App({
            token: config.botToken,
            appToken: config.appToken,
            socketMode: true,
            logLevel: 'error'
        });


        this.httpPort = config.httpPort || 9999;
        this.httpServer = null;

        // Connection state tracking
        this.connected = false;
        this._healthCheckInterval = null;

        // WebSocket error resilience
        this._wsErrors = [];                  // timestamps of recent WS errors
        this._wsErrorWindowMs = 120000;       // 2-minute sliding window
        this._wsRestarting = false;           // prevent concurrent restarts
        this._wsEscalationLevel = 0;         // 0=none, 1=warn, 2=restart, 3=exit+notify
        this._lastOwnerNotifyTs = 0;          // cooldown for owner DM
        this._ownerNotifyCooldownMs = 300000; // 5 min cooldown
        this._startedAt = Date.now();         // for uptime reporting
        this._wsRestartWindowMs = 600000;     // 10 min window for restart tracking
        this._wsRestartStateFile = path.join(__dirname, '../../data/ws-restart-state.json');
        this._wsRestartTimestamps = this._loadRestartState(); // persisted across process restarts
        // Pane scrollback snapshots — captured while a session is alive so a
        // later recreate can replay the actual CLI conversation when native
        // `--resume` isn't available (no captured session UUID). See
        // `_snapshotPaneForResume` / `_readPaneSnapshot`.
        this._paneSnapshotDir = path.join(__dirname, '../../data/pane-snapshots');

        this._initDb();

        // Alert monitoring
        this.alertMonitor = new AlertMonitor(this.app, config);
        this.trackedIncidents = new Map(); // incidentId → { channelId, messageTs }
        this._ackInFlight = new Map();     // incidentId → Promise — dedup concurrent PD acks

        // Delay alert monitoring
        this.delayAlertMonitor = new DelayAlertMonitor(this.app, this.db, config);

        // @mention access control: owner + allowed subteams only (when set).
        this.accessControl = new AccessControl({
            client: this.app.client,
            ownerUserId: config.ownerUserId,
            allowedSubteams: config.allowedSubteams || [],
            whitelist: config.whitelist || [],
            writeSubteams: config.writeSubteams || [],
            logger: this.logger,
        });
        // slackUid -> { name, at } cache for the per-turn sender-identity header
        // (_resolveSenderName). 10-min TTL; best-effort, never blocks a message.
        this._senderNameCache = new Map();

        this._setupListeners();
        this._setupHttpServer();
    }

    // ─── SQLite ──────────────────────────────────────────────────────

    _initDb() {
        const dbDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = this.config.dbPath || path.join(dbDir, 'slack-sessions.db');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_key   TEXT PRIMARY KEY,
                session_name  TEXT NOT NULL,
                channel_id    TEXT NOT NULL,
                thread_ts     TEXT NOT NULL,
                repo_path     TEXT NOT NULL,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                last_bot_ts   TEXT
            )
        `);

        // Migrate: add columns if missing (existing DBs)
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_bot_ts TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN alert_message_ts TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_user_id TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'");
        } catch {
            // Column already exists
        }
        try {
            // ms epoch of the last *user* message injected. Distinct from
            // `updated_at` (bumped by bot replies too via the Stop hook), so it's
            // the only reliable "did the bot still owe a reply?" signal on restart.
            this.db.prepare('ALTER TABLE sessions ADD COLUMN last_user_ts INTEGER').run();
        } catch {
            // Column already exists
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_claude_session_id ON sessions(claude_session_id)');

        // Alert investigation queue — process alerts sequentially to avoid resource contention
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS alert_queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                incident_id TEXT,
                channel_id  TEXT NOT NULL,
                message_ts  TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                alert_type  TEXT NOT NULL DEFAULT 'pagerduty',
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            )
        `);
        try {
            this.db.exec('ALTER TABLE alert_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
        } catch {
            // Column already exists
        }
        try {
            // FIX C — the CLI chain to use when this item is (re)processed, as a
            // JSON array. On requeue we rewrite it with the chain still untried
            // after the failed run advanced past dead CLIs (e.g. the geo-blocked
            // gemini), so retries don't re-burn the whole chain from the top.
            // NULL → fall back to the configured alertCliChain.
            this.db.prepare('ALTER TABLE alert_queue ADD COLUMN cli_chain TEXT').run();
        } catch {
            // Column already exists
        }
        this.db.prepare('CREATE INDEX IF NOT EXISTS idx_alert_queue_status ON alert_queue(status)').run();

        this._stmts = {
            upsert: this.db.prepare(`
                INSERT INTO sessions (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at, alert_message_ts, cli_type)
                VALUES (@session_key, @session_name, @channel_id, @thread_ts, @repo_path, @created_at, @updated_at, @alert_message_ts, @cli_type)
                ON CONFLICT(session_key) DO UPDATE SET
                    updated_at = @updated_at,
                    cli_type = @cli_type,
                    claude_session_id = NULL
            `),
            get: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
            all: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
            delete: this.db.prepare('DELETE FROM sessions WHERE session_key = ?'),
            deleteOld: this.db.prepare('DELETE FROM sessions WHERE updated_at < ?'),
            touch: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?'),
            updateLastBotTs: this.db.prepare('UPDATE sessions SET last_bot_ts = ?, updated_at = ? WHERE session_key = ?'),
            updateLastUserId: this.db.prepare('UPDATE sessions SET last_user_id = ?, last_user_ts = ?, updated_at = ? WHERE session_key = ?'),
            deleteByNameExcept: this.db.prepare('DELETE FROM sessions WHERE session_name = ? AND session_key != ?'),
            getByClaudeSessionId: this.db.prepare('SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1'),
            updateClaudeSessionId: this.db.prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE session_key = ?')
        };

        this._queueStmts = {
            enqueue: this.db.prepare(`
                INSERT INTO alert_queue (incident_id, channel_id, message_ts, prompt, status, alert_type, created_at, updated_at)
                VALUES (@incident_id, @channel_id, @message_ts, @prompt, 'pending', @alert_type, @created_at, @updated_at)
            `),
            dequeue: this.db.prepare("SELECT * FROM alert_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"),
            countPending: this.db.prepare("SELECT COUNT(*) as count FROM alert_queue WHERE status = 'pending'"),
            countProcessing: this.db.prepare("SELECT COUNT(*) as count FROM alert_queue WHERE status = 'processing'"),
            getProcessing: this.db.prepare("SELECT * FROM alert_queue WHERE status = 'processing'"),
            getByMessage: this.db.prepare("SELECT * FROM alert_queue WHERE channel_id = ? AND message_ts = ? AND status IN ('pending', 'processing') LIMIT 1"),
            getLatestForMessage: this.db.prepare("SELECT * FROM alert_queue WHERE channel_id = ? AND message_ts = ? ORDER BY id DESC LIMIT 1"),
            updateStatus: this.db.prepare('UPDATE alert_queue SET status = ?, updated_at = ? WHERE id = ?'),
            requeueForRetry: this.db.prepare("UPDATE alert_queue SET status = 'pending', retry_count = retry_count + 1, updated_at = ? WHERE id = ? AND status = 'processing'"),
            updateChain: this.db.prepare('UPDATE alert_queue SET cli_chain = ?, updated_at = ? WHERE id = ?'),
            complete: this.db.prepare("UPDATE alert_queue SET status = 'completed', updated_at = ? WHERE channel_id = ? AND message_ts = ? AND status = 'processing'"),
            // Atomic promotion: claim a pending row for a manual "investigate now"
            // override. Filter on status='pending' so we lose cleanly to a racing
            // _processNextInQueue dequeue (result.changes === 0 then).
            promote: this.db.prepare("UPDATE alert_queue SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'"),
            cleanOld: this.db.prepare("DELETE FROM alert_queue WHERE status IN ('completed', 'failed') AND updated_at < ?"),
            all: this.db.prepare('SELECT * FROM alert_queue ORDER BY created_at DESC LIMIT 50'),
        };

        // Clean up sessions older than 7 days
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const deleted = this._stmts.deleteOld.run(weekAgo);
        if (deleted.changes > 0) {
            this.logger.info(`Cleaned up ${deleted.changes} expired sessions from DB`);
        }

        this.jobs = new Jobs(this.db);
        this.prTasks = new PrTasks(this.db);
        this.agentSessions = new AgentSessions(this.db);
    }

    _saveSession(session) {
        const sessionKey = `${session.channelId}-${session.threadTs}`;
        // Remove stale DB entries with the same tmux session name (from timed-out sessions
        // whose threadTs produced the same 6-digit suffix). Without this, the hook's
        // session_name lookup could return the old/wrong thread.
        this._stmts.deleteByNameExcept.run(session.sessionName, sessionKey);
        this._stmts.upsert.run({
            session_key: sessionKey,
            session_name: session.sessionName,
            channel_id: session.channelId,
            thread_ts: session.threadTs,
            repo_path: session.repoPath,
            created_at: session.createdAt,
            updated_at: Date.now(),
            alert_message_ts: session.alertMessageTs || null,
            cli_type: session.cliType || 'claude'
        });
    }

    _getSession(sessionKey) {
        const row = this._stmts.get.get(sessionKey);
        if (!row) return null;
        return {
            sessionName: row.session_name,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
            repoPath: row.repo_path,
            createdAt: row.created_at,
            updatedAt: row.updated_at || null,
            lastBotTs: row.last_bot_ts || null,
            alertMessageTs: row.alert_message_ts || null,
            lastUserId: row.last_user_id || null,
            claudeSessionId: row.claude_session_id || null,
            cliType: row.cli_type || 'claude'
        };
    }

    _getAllSessions() {
        return this._stmts.all.all().map(row => ({
            sessionKey: row.session_key,
            sessionName: row.session_name,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
            repoPath: row.repo_path,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            alertMessageTs: row.alert_message_ts || null,
            claudeSessionId: row.claude_session_id || null
        }));
    }

    _deleteSession(sessionKey) {
        // Best-effort MCP cleanup before the row goes. Read cli_type so we
        // route to the right adapter: Claude removes a session file, while
        // Codex/Gemini keep global shared config entries in place. Failure
        // here must never block the DB delete.
        try {
            const row = this._stmts.get.get(sessionKey);
            const cliType = row && row.cli_type;
            if (cliType) {
                const adapter = getCliAdapter(cliType);
                if (typeof adapter.uninstallMcp === 'function') {
                    adapter.uninstallMcp({ sessionKey });
                }
            }
        } catch (err) {
            this.logger.warn(`uninstallMcp on session delete failed for ${sessionKey}: ${err.message}`);
        }
        this._stmts.delete.run(sessionKey);
    }

    /**
     * Reap the session whose thread-root message was just deleted. The session
     * key is `${channel}-${threadTs}` and a top-level spawning message uses its
     * own ts as the thread root, so a deleted message's ts maps straight to the
     * session key. (Deleting a follow-up thread reply won't match — those keys
     * carry the thread root ts, not the reply's — so we only reap when the user
     * actually removes the message that started the session.) No-op when no
     * session matches. Mirrors the `/exit` teardown minus the inject, since the
     * tmux pane is killed outright rather than asked to exit cleanly.
     */
    _reapOrphanedSession(channelId, deletedTs) {
        if (!channelId || !deletedTs) return;
        const sessionKey = `${channelId}-${deletedTs}`;
        const session = this._getSession(sessionKey);
        if (!session) return;
        this.logger.info(`Message ${deletedTs} deleted in ${channelId} — reaping orphaned session ${session.sessionName}`);

        const pollKey = session.sessionName;
        if (this.pollers.has(pollKey)) {
            clearInterval(this.pollers.get(pollKey).interval);
            this.pollers.delete(pollKey);
        }
        // sessionName is bot-generated ("slack-AYGY-<digits>"), never user
        // input — same kill idiom as the alert-retry teardown.
        const killCmd = 'tmux kill-session -t ' + session.sessionName + ' 2>/dev/null';
        try { execSync(killCmd); } catch { /* already gone */ }
        this._clearSessionTimeout(sessionKey);
        this._clearPaneSnapshot(sessionKey);

        // If it was an alert investigation, free the queue slot so the next
        // pending incident can start. Skip the 👀→✅ reaction swap — the alert
        // message is gone, so reacting to it would just error.
        if (session.alertMessageTs) {
            this._completeQueueItem(channelId, session.alertMessageTs);
        }
        this._deleteSession(sessionKey);
    }

    _touchSession(sessionKey) {
        this._stmts.touch.run(Date.now(), sessionKey);
    }

    // ─── Alert Queue ─────────────────────────────────────────────────

    _enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType = 'pagerduty' }) {
        // Dedup: skip if already queued for this message
        const existing = this._queueStmts.getByMessage.get(channelId, messageTs);
        if (existing) {
            this.logger.info(`Alert already queued (status=${existing.status}): channel=${channelId} ts=${messageTs}`);
            return 0;
        }

        const now = Date.now();
        this._queueStmts.enqueue.run({
            incident_id: incidentId || null,
            channel_id: channelId,
            message_ts: messageTs,
            prompt,
            alert_type: alertType,
            created_at: now,
            updated_at: now
        });
        const position = this._queueStmts.countPending.get().count;
        this.logger.info(`Alert queued: incident=${incidentId} type=${alertType} channel=${channelId} ts=${messageTs} position=${position}`);
        return position;
    }

    _processNextInQueue() {
        const maxConcurrent = this.config.alertMaxConcurrent || 1;
        const active = this._queueStmts.countProcessing.get().count;

        if (active >= maxConcurrent) {
            const pending = this._queueStmts.countPending.get().count;
            if (pending > 0) {
                this.logger.info(`Alert queue: ${active}/${maxConcurrent} slots busy, ${pending} pending`);
            }
            return;
        }

        const item = this._queueStmts.dequeue.get();
        if (!item) {
            return;
        }

        // Mark as processing
        this._queueStmts.updateStatus.run('processing', Date.now(), item.id);
        this.logger.info(`Alert queue: processing id=${item.id} incident=${item.incident_id} channel=${item.channel_id} ts=${item.message_ts}`);

        // Swap hourglass → eyes whenever a queued item starts. The reaction
        // is the only signal that the alert moved past "waiting" — gating it
        // on wait time hides short-queue starts (under a minute) entirely.
        // The chat notice stays gated so near-instant dequeues don't spam.
        const waitedMs = Date.now() - item.created_at;
        this._removeReaction(item.channel_id, item.message_ts, 'hourglass_flowing_sand').catch(() => {});
        this._addReaction(item.channel_id, item.message_ts, 'eyes').catch(() => {});
        if (waitedMs > 60000) {
            this.app.client.chat.postMessage({
                channel: item.channel_id,
                text: `:mag: Starting investigation (waited ${Math.round(waitedMs / 60000)}m in queue)...`,
                thread_ts: item.message_ts
            }).catch(err => this.logger.error(`Failed to post queue start notice: ${err.message}`));
        }

        // Fire the investigation via the regular command flow. Queue only holds PagerDuty alerts,
        // so the CLI chain follows ALERT_CLI (delay alerts bypass the queue).
        // FIX C — a requeued item carries the chain still untried after the
        // previous run advanced past dead CLIs; use it so we don't restart from
        // the geo-blocked first CLI every retry. Falls back to the full
        // configured chain for fresh items (cli_chain NULL) or on parse error.
        const fullChain = this.config.alertCliChain || ['claude'];
        let queueCliChain = fullChain;
        if (item.cli_chain) {
            try {
                const parsed = JSON.parse(item.cli_chain);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    queueCliChain = parsed;
                }
            } catch (err) {
                this.logger.warn(`Alert queue: bad cli_chain JSON for id=${item.id} (${err.message}) — using full chain`);
            }
        }
        this._processCommand(item.channel_id, item.message_ts, item.prompt, null, item.message_ts, item.message_ts, null, queueCliChain)
            .catch(err => {
                this.logger.error(`Alert queue: failed to start investigation for id=${item.id}: ${err.message}`);
                this._queueStmts.updateStatus.run('failed', Date.now(), item.id);
                // Try next
                setImmediate(() => this._processNextInQueue());
            });
    }

    _completeQueueItem(channelId, messageTs, opts = {}) {
        let { silent = false } = opts;
        const maxRetries = this.config.alertSilentMaxRetries ?? 2;

        // Cross-check the caller's `silent` claim against DB state: if any bot
        // message has been posted for this alert's session (last_bot_ts non-null),
        // requeueing would duplicate the investigation. Catches races where the
        // hook fires between the caller deciding 'silent' and reaching us, and
        // also where the poller watchdog has already rescued the report.
        if (silent) {
            const sessionRow = this._stmts.get.get(`${channelId}-${messageTs}`);
            if (sessionRow && sessionRow.last_bot_ts) {
                this.logger.info(`Alert queue: skip silent-requeue for channel=${channelId} ts=${messageTs} — last_bot_ts=${sessionRow.last_bot_ts} (bot already posted)`);
                silent = false;
            }
        }

        // Silent failure: investigation produced no output. Requeue if we
        // still have retry budget, so the same alert gets a fresh tmux run
        // (covering the Codex-splash-swallowed-prompt class of bug).
        if (silent) {
            const item = this._queueStmts.getLatestForMessage.get(channelId, messageTs);
            // Only requeue items that are still 'processing' — anything else
            // (already completed/failed/missing) means a different code path
            // already settled it; don't double-handle.
            if (item && item.status === 'processing' && item.retry_count < maxRetries) {
                const result = this._queueStmts.requeueForRetry.run(Date.now(), item.id);
                if (result.changes > 0) {
                    const attempt = item.retry_count + 2; // human-friendly: 2nd attempt, 3rd attempt...
                    const total = maxRetries + 1;
                    // FIX C — persist the chain still untried so the retry resumes
                    // from where the failed run reached instead of the geo-blocked
                    // first CLI. The failed run's session row records the CLI that
                    // was actually running (cli_type); the configured chain from
                    // that CLI onward is what's left to try.
                    const fullChain = this.config.alertCliChain || ['claude'];
                    let remainingChain = fullChain;
                    const failedSession = this._stmts.get.get(`${channelId}-${messageTs}`);
                    if (failedSession && failedSession.cli_type) {
                        const idx = fullChain.indexOf(failedSession.cli_type);
                        if (idx > 0) remainingChain = fullChain.slice(idx);
                    }
                    this._queueStmts.updateChain.run(JSON.stringify(remainingChain), Date.now(), item.id);
                    this.logger.warn(`Alert queue: silent failure detected — requeue id=${item.id} attempt=${attempt}/${total} chain=[${remainingChain.join(' → ')}]`);
                    // Restore eyes on the alert message (cleanup paths swap to
                    // ✅ before calling us; flip it back since we're retrying).
                    this._removeReaction(channelId, messageTs, 'white_check_mark').catch(() => {});
                    this._addReaction(channelId, messageTs, 'eyes').catch(() => {});
                    this.app.client.chat.postMessage({
                        channel: channelId,
                        thread_ts: messageTs,
                        text: `:repeat: Investigation produced no output (likely a CLI startup race) — retrying (attempt ${attempt}/${total}).`
                    }).catch(err => this.logger.error(`Failed to post requeue notice: ${err.message}`));
                    setImmediate(() => this._processNextInQueue());
                    return;
                }
            }
            // Out of retries (or item not found / already settled): post a
            // give-up notice so the on-call human knows to triage manually,
            // then fall through to normal completion.
            if (item && item.status === 'processing' && item.retry_count >= maxRetries) {
                this.logger.error(`Alert queue: giving up on silent failure id=${item.id} after ${item.retry_count + 1} attempts`);
                this.app.client.chat.postMessage({
                    channel: channelId,
                    thread_ts: messageTs,
                    text: `:x: Investigation gave up after ${item.retry_count + 1} silent failures — manual triage required.`
                }).catch(err => this.logger.error(`Failed to post give-up notice: ${err.message}`));
            }
        }

        const result = this._queueStmts.complete.run(Date.now(), channelId, messageTs);
        if (result.changes > 0) {
            this.logger.info(`Alert queue: completed item channel=${channelId} ts=${messageTs}`);
        }
        // Process next in queue after current slot frees up
        setImmediate(() => this._processNextInQueue());
    }

    _recoverQueue() {
        // Reset stale 'processing' items that don't have active tmux sessions
        const processing = this._queueStmts.getProcessing.all();
        let recovered = 0;
        for (const item of processing) {
            const sessionKey = `${item.channel_id}-${item.message_ts}`;
            const session = this._getSession(sessionKey);
            if (!session || !this._isTmuxSessionAlive(session.sessionName)) {
                this._queueStmts.updateStatus.run('pending', Date.now(), item.id);
                recovered++;
                this.logger.info(`Alert queue: recovered stale item id=${item.id} incident=${item.incident_id}`);
            }
        }
        // Clean up old completed/failed items (older than 24h)
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        this._queueStmts.cleanOld.run(dayAgo);

        const pending = this._queueStmts.countPending.get().count;
        if (recovered > 0 || pending > 0) {
            this.logger.info(`Alert queue recovery: ${recovered} reset to pending, ${pending} total pending`);
        }
    }

    /**
     * On startup, check which DB sessions still have a live tmux session.
     * Remove dead ones.
     */
    async _reconcileSessions() {
        const sessions = this._getAllSessions();
        let alive = 0;
        let removed = 0;

        for (const s of sessions) {
            if (this._isTmuxSessionAlive(s.sessionName)) {
                alive++;
                this._startSessionTimeout(s.sessionKey);
                this.logger.info(`Recovered session: ${s.sessionName} (channel ${s.channelId}) — timeout set`);
            } else {
                // Swap alert reactions for dead alert sessions
                const row = this._stmts.get.get(s.sessionKey);
                if (row?.alert_message_ts) {
                    await this._removeReaction(s.channelId, row.alert_message_ts, 'eyes');
                    await this._addReaction(s.channelId, row.alert_message_ts, 'white_check_mark');
                    this.logger.info(`Alert session ${s.sessionName} dead — swapped reactions`);
                } else {
                    // Non-alert session that didn't survive the restart. A full
                    // process/systemd restart kills the whole control group, so
                    // any @mention task that was in-flight (user message injected,
                    // no Stop-hook reply after it) dies silently. Tell the thread
                    // so the user can re-send — but only if the bot genuinely still
                    // owed a reply: the last user message (`last_user_ts`, ms) is
                    // newer than the last bot reply (`last_bot_ts`, Slack ts). We
                    // can't use `updated_at` here — the Stop hook bumps it on every
                    // reply too, so it would fire even for cleanly-answered turns.
                    const userMs = row?.last_user_ts || 0;
                    const botMs = this._parseBotTsMs(row?.last_bot_ts) || 0;
                    const recencyMs = Math.max(this.config.sessionInactivityTimeoutMs || 300000, 3600000);
                    const owedReply = userMs > botMs && (Date.now() - userMs) < recencyMs;
                    if (owedReply && row?.last_user_id) {
                        try {
                            await this.app.client.chat.postMessage({
                                channel: s.channelId,
                                thread_ts: s.threadTs,
                                text: `<@${row.last_user_id}> :recycle: I restarted before finishing your last request and lost the in-flight task — please re-send your message to retry.`,
                            });
                            this.logger.info(`Restart re-send notice posted for ${s.sessionName}`);
                        } catch (err) {
                            this.logger.warn(`Restart re-send notice failed for ${s.sessionName}: ${err.message}`);
                        }
                    }
                }
                this._deleteSession(s.sessionKey);
                this._clearSessionTimeout(s.sessionKey);
                removed++;
            }
        }

        this.logger.info(`Session reconciliation: ${alive} alive, ${removed} stale removed`);

        // Recover alert queue — reset stale 'processing' items, then start processing
        this._recoverQueue();
        this._processNextInQueue();

        // Kill orphan tmux sessions not tracked in DB
        try {
            const tmuxList = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null").toString().trim();
            if (tmuxList) {
                const dbSessionNames = new Set(sessions.map(s => s.sessionName));
                const orphans = tmuxList.split('\n').filter(name => name.startsWith('slack-') && !dbSessionNames.has(name));
                for (const name of orphans) {
                    try {
                        execSync(`tmux kill-session -t ${name} 2>/dev/null`);
                        this.logger.info(`Killed orphan tmux session: ${name}`);
                    } catch (_) {}
                }
                if (orphans.length > 0) {
                    this.logger.info(`Killed ${orphans.length} orphan tmux sessions not in DB`);
                }
            }
        } catch (_) { /* no tmux server running */ }
    }

    _isTmuxSessionAlive(sessionName) {
        try {
            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
            return true;
        } catch {
            return false;
        }
    }

    // ─── Slack Image Download ─────────────────────────────────────────

    /**
     * Download image files from a Slack message to a temp directory.
     * @param {Array} files - Slack message files array
     * @param {string} dirName - Directory name under /tmp for storing images
     * @returns {string[]} Array of downloaded file paths
     */
    async _downloadSlackImages(files, dirName) {
        if (!files || files.length === 0) return [];

        const imageFiles = files.filter(f => f.mimetype?.startsWith('image/'));
        if (imageFiles.length === 0) return [];

        const imageDir = path.join('/tmp', dirName);
        fs.mkdirSync(imageDir, { recursive: true });

        const downloaded = [];
        for (const file of imageFiles) {
            try {
                const filePath = path.join(imageDir, file.name || `image-${Date.now()}.png`);
                const response = await axios.get(file.url_private_download, {
                    headers: { Authorization: `Bearer ${this.config.botToken}` },
                    responseType: 'arraybuffer'
                });
                fs.writeFileSync(filePath, response.data);
                downloaded.push(filePath);
                this.logger.info(`Downloaded Slack image: ${filePath} (${file.mimetype})`);
            } catch (e) {
                this.logger.warn(`Failed to download Slack file ${file.name}: ${e.message}`);
            }
        }
        return downloaded;
    }

    // ─── Reaction Helpers ──────────────────────────────────────────────

    async _addReaction(channelId, messageTs, name) {
        try {
            await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name });
        } catch (error) {
            if (!error.message?.includes('already_reacted')) {
                this.logger.error(`Failed to add reaction ${name}: ${error.message}`);
            }
        }
    }

    async _removeReaction(channelId, messageTs, name) {
        try {
            await this.app.client.reactions.remove({ channel: channelId, timestamp: messageTs, name });
        } catch (error) {
            if (!error.message?.includes('no_reaction')) {
                this.logger.error(`Failed to remove reaction ${name}: ${error.message}`);
            }
        }
    }

    // ─── Assistant Thinking Status ─────────────────────────────────────
    // Drives Slack's native assistant status under the app name (OpenClaw's
    // "Gathering information…" line) via assistant.threads.setStatus. The
    // animation comes from `loading_messages` — Slack rotates through that
    // array to produce the moving loading indicator; a bare `status` renders
    // static. Pass an empty status (and no loading_messages) to clear it.
    // Best-effort: the call fails harmlessly on non-assistant threads or if
    // the workspace lacks the assistant feature, so errors are swallowed and
    // never block polling. Uses apiCall() so it works across @slack/web-api
    // versions that may not expose the typed assistant.threads method.
    async _setThreadStatus(channelId, threadTs, status, loadingMessages = null) {
        if (!channelId || !threadTs) return;
        try {
            const args = {
                channel_id: channelId,
                thread_ts: threadTs,
                status: status || '',
            };
            if (Array.isArray(loadingMessages) && loadingMessages.length > 0) {
                args.loading_messages = loadingMessages;
            }
            await this.app.client.apiCall('assistant.threads.setStatus', args);
        } catch (error) {
            this.logger.debug(`setStatus skipped for ${channelId}/${threadTs}: ${error.message}`);
        }
    }

    // ─── PagerDuty API ──────────────────────────────────────────────

    async _acknowledgePagerDuty(incidentId) {
        if (!incidentId) return null;
        // Dedup concurrent calls: if an ack is in flight (or completed within the TTL),
        // return the same Promise so only one PD API round-trip runs per incident.
        // Fixes the race where webhook + Socket Mode both fired PUT /incidents/{id} and
        // PagerDuty's bot posted "Acknowledged" twice.
        if (this._ackInFlight.has(incidentId)) {
            return this._ackInFlight.get(incidentId);
        }
        const promise = this._doAcknowledgePagerDuty(incidentId);
        this._ackInFlight.set(incidentId, promise);
        // Keep the entry for 60s so late callers also hit the cached result
        // (PD status may lag a few seconds after our PUT).
        setTimeout(() => this._ackInFlight.delete(incidentId), 60_000);
        return promise;
    }

    async _doAcknowledgePagerDuty(incidentId) {
        const token = this.config.pagerdutyApiToken;
        const fromEmail = this.config.pagerdutyFromEmail;
        if (!token || !incidentId) return null;

        try {
            const statusRes = await axios.get(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                { headers: { 'Authorization': `Token token=${token}`, 'Content-Type': 'application/json' } }
            );
            const status = statusRes.data?.incident?.status;
            this.logger.info(`PD incident ${incidentId} status: ${status}`);

            if (status === 'acknowledged' || status === 'resolved') {
                return { skipped: true, status };
            }

            await axios.put(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                { incident: { type: 'incident_reference', status: 'acknowledged' } },
                { headers: { 'Authorization': `Token token=${token}`, 'Content-Type': 'application/json', 'From': fromEmail } }
            );
            this.logger.info(`PD incident ${incidentId} acknowledged`);
            return { skipped: false, status: 'acknowledged' };
        } catch (error) {
            this.logger.error(`PD API error for ${incidentId}: ${error.message}`);
            return null;
        }
    }

    // ─── Thread Context ─────────────────────────────────────────────

    /**
     * Fetch thread messages from Slack, optionally only those after a given timestamp.
     * @param {string} channelId - The Slack channel ID
     * @param {string} threadTs - The thread root timestamp
     * @param {string|null} sinceTs - Only return messages after this timestamp (exclusive)
     * @returns {Array<{user: string, text: string, ts: string}>}
     */
    async _fetchThreadMessages(channelId, threadTs, sinceTs = null, { includeBotMessages = true } = {}) {
        const messages = [];
        let cursor;

        do {
            const result = await this.app.client.conversations.replies({
                channel: channelId,
                ts: threadTs,
                limit: 200,
                ...(cursor ? { cursor } : {})
            });

            for (const msg of (result.messages || [])) {
                if (sinceTs && parseFloat(msg.ts) <= parseFloat(sinceTs)) continue;
                // Optionally skip bot messages (for live session injection — no context needed)
                if (!includeBotMessages && (msg.bot_id || (msg.app_id && !msg.user))) continue;

                const isBot = !!(msg.bot_id || (msg.app_id && !msg.user));
                let text = msg.text || '';

                // Fetch file attachments via Gemini (skip for bot messages to avoid re-describing our own uploads)
                if (!isBot && msg.files && msg.files.length > 0) {
                    const fileContents = await this._fetchFileContents(msg.files);
                    if (fileContents) {
                        text += '\n' + fileContents;
                    }
                }

                messages.push({
                    user: msg.user || (isBot ? 'EnzoBot' : 'unknown'),
                    text,
                    ts: msg.ts,
                    isBot
                });
            }

            cursor = result.response_metadata?.next_cursor;
        } while (cursor);

        return messages;
    }

    /**
     * Fetch file attachments from Slack and describe/summarize via Gemini.
     * All file types go through Gemini — images get vision description,
     * text/code files get summarized. Skips files >10MB.
     */
    async _fetchFileContents(files) {
        if (!files || files.length === 0) return null;

        const { openrouterComplete, fileToContentPart } = require('../../utils/openrouter');
        if (!process.env.OPENROUTER_API_KEY) {
            this.logger.warn('OPENROUTER_API_KEY not set, skipping file content extraction');
            return null;
        }

        const parts = [];
        for (const file of files) {
            if (!file.mimetype || file.size > 10000000) continue;

            try {
                const response = await axios.get(file.url_private_download, {
                    headers: { Authorization: `Bearer ${this.config.botToken}` },
                    responseType: 'arraybuffer'
                });
                const base64 = Buffer.from(response.data).toString('base64');

                const filePart = fileToContentPart(file.mimetype, base64, file.name);
                if (!filePart) {
                    this.logger.warn(`Skipping unsupported file ${file.name} (${file.mimetype})`);
                    continue;
                }

                const description = await openrouterComplete([{
                    role: 'user',
                    content: [
                        { type: 'text', text: `Describe this file concisely for a software engineer. For images: what it shows, key details, any visible text. For code/text/logs: summarize the content and key points. File: ${file.name} (${file.mimetype}). Keep it under 300 words.` },
                        filePart,
                    ],
                }], { maxTokens: 600 });

                parts.push(`[Attached: ${file.name}]\n${description}`);
                this.logger.info(`OpenRouter described ${file.name} (${file.mimetype}, ${file.size}b): ${description.substring(0, 80)}...`);
            } catch (e) {
                this.logger.warn(`Failed to process file ${file.name}: ${e.message}`);
            }
        }

        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    /**
     * Resolve a Slack user ID to a display name. Caches results in memory.
     */
    async _resolveUserName(userId) {
        if (!this._userCache) this._userCache = new Map();
        if (this._userCache.has(userId)) return this._userCache.get(userId);

        try {
            const result = await this.app.client.users.info({ user: userId });
            const name = result.user?.profile?.display_name
                || result.user?.profile?.real_name
                || result.user?.name
                || userId;
            this._userCache.set(userId, name);
            return name;
        } catch {
            this._userCache.set(userId, userId);
            return userId;
        }
    }

    /**
     * Format thread messages into a context string for Claude.
     * Replaces <@UXXXX> mentions with display names.
     */
    async _formatThreadContext(messages) {
        // Collect all unique user IDs (from messages and mentions)
        const userIds = new Set();
        for (const msg of messages) {
            userIds.add(msg.user);
            const mentions = msg.text.match(/<@([A-Z0-9]+)>/g) || [];
            for (const m of mentions) {
                userIds.add(m.replace(/<@|>/g, ''));
            }
        }

        // Resolve all names in parallel
        const nameMap = new Map();
        await Promise.all([...userIds].map(async (id) => {
            nameMap.set(id, await this._resolveUserName(id));
        }));

        // Format each message
        const lines = messages.map(msg => {
            let text = msg.text;
            // Replace <@UXXXX> with display names
            text = text.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${nameMap.get(id) || id}`);
            const name = nameMap.get(msg.user) || msg.user;
            return `${name}: ${text}`;
        });

        return lines.join('\n');
    }

    /**
     * Summarize a long thread using Gemini Flash for concise context injection.
     * For very large threads, truncates to last ~800KB to stay within Gemini's limits.
     * Falls back to raw formatted messages if Gemini is unavailable.
     */
    async _summarizeThreadContext(messages) {
        const formatted = await this._formatThreadContext(messages);
        try {
            const { openrouterComplete } = require('../../utils/openrouter');
            if (!process.env.OPENROUTER_API_KEY) {
                this.logger.warn('OPENROUTER_API_KEY not set, using raw thread context');
                return formatted;
            }

            // Truncate very large threads — keep the last ~800KB.
            const maxChars = 800000;
            let content = formatted;
            if (content.length > maxChars) {
                content = '... (earlier messages truncated)\n\n' + content.slice(-maxChars);
                this.logger.info(`Thread truncated from ${formatted.length} to ${maxChars} chars`);
            }

            const summary = await openrouterComplete([{
                role: 'user',
                content: `Summarize this Slack thread conversation concisely. Focus on: what was requested, what was done, current state, and any pending items. Keep it under 500 words.\n\n${content}`,
            }], { maxTokens: 800 });

            this.logger.info(`Thread summarized: ${messages.length} messages → ${summary.length} chars`);
            return `Previous conversation summary:\n${summary}`;
        } catch (err) {
            this.logger.warn(`Summarization failed, using raw context: ${err.message}`);
            return formatted;
        }
    }

    /**
     * Detect the project path from thread history using Gemini.
     * Looks for "start from X project" patterns and path mentions in the conversation.
     */
    async _detectProjectFromThread(messages) {
        try {
            const { openrouterComplete } = require('../../utils/openrouter');
            if (!process.env.OPENROUTER_API_KEY) return null;

            const formatted = await this._formatThreadContext(messages);
            const repoRoot = this.config.repoRoot || '';

            const detected = (await openrouterComplete([{
                role: 'user',
                content: `From this Slack thread, identify the project directory path that was being used for the Claude Code session.
Look for patterns like:
- "start claude from X project"
- "Starting Claude session in /path/to/..."
- Any file paths mentioned that indicate the project root

The repo root is: ${repoRoot}

Return ONLY the absolute directory path, nothing else. If you cannot determine it, return "unknown".

Thread:
${formatted}`,
            }], { maxTokens: 100 })).trim();
            if (detected && detected !== 'unknown' && detected.startsWith('/')) {
                this.logger.info(`Gemini detected project from thread: ${detected}`);
                return detected;
            }
        } catch (err) {
            this.logger.warn(`Gemini project detection failed: ${err.message}`);
        }
        return null;
    }

    /**
     * Update the last bot response timestamp for a session.
     */
    _updateLastBotTs(sessionKey, ts) {
        this._stmts.updateLastBotTs.run(ts, Date.now(), sessionKey);
    }

    _updateLastUserId(sessionKey, userId) {
        const now = Date.now();
        this._stmts.updateLastUserId.run(userId, now, now, sessionKey);
    }

    // ─── Slack Event Listeners ───────────────────────────────────────

    _setupConnectionMonitor() {
        const receiver = this.app.receiver;
        if (!receiver || !receiver.client) {
            this.logger.warn('Cannot attach connection monitor: no Socket Mode receiver');
            return;
        }

        const client = receiver.client;

        client.on('connected', () => this._handleSocketConnected());

        client.on('disconnected', () => {
            this.connected = false;
            this.logger.warn('Socket Mode disconnected');
            // Abort any pending recovery DM — if WS is dropping again, the
            // previous failure has not actually recovered yet.
            if (this._wsRecoveryNoticeTimer) {
                clearTimeout(this._wsRecoveryNoticeTimer);
                this._wsRecoveryNoticeTimer = null;
            }
            this._recordWsError('disconnected', 'Socket Mode disconnected');
        });

        client.on('error', (error) => {
            this.logger.warn(`Socket Mode error: ${error.message}`);
            this._recordWsError('error', error.message);
        });

        client.on('close', (code, reason) => {
            this.connected = false;
            this.logger.warn(`Socket Mode closed: code=${code} reason=${reason || 'none'}`);
            this._recordWsError('close', `code=${code} reason=${reason || 'none'}`);
        });

        client.on('reconnecting', () => {
            this.logger.info('Socket Mode reconnecting...');
        });

        // app.start() already returned, meaning the socket is connected; the
        // 'connected' event has already fired and our listener missed it.
        // Invoke the handler once to catch up. The handler is idempotent.
        this._handleSocketConnected();
    }

    _handleSocketConnected() {
        const wasConnected = this.connected;
        this.connected = true;
        if (!wasConnected) this.logger.info('Socket Mode connected');
        this._wsErrors = [];
        this._wsEscalationLevel = 0;

        // If the previous process exited and DM'd the owner, send a recovery
        // DM once the new connection holds for 30s.
        if (this._pendingRecoveryNotice && !this._wsRecoveryNoticeTimer) {
            const prev = this._pendingRecoveryNotice;
            this._wsRecoveryNoticeTimer = setTimeout(() => {
                this._wsRecoveryNoticeTimer = null;
                if (!this.connected || !this._pendingRecoveryNotice) return;
                this._pendingRecoveryNotice = null;
                this._saveRestartState();
                this._notifyOwnerWsRecovered(prev).catch(err =>
                    this.logger.error(`Recovery notice failed: ${err.message}`)
                );
            }, 30000);
        }

        // Clear persisted restart state after 5 min of stable connection.
        if (this._wsStabilityTimer) clearTimeout(this._wsStabilityTimer);
        this._wsStabilityTimer = setTimeout(() => {
            if (this.connected) {
                this._clearRestartState();
                this.logger.info('WebSocket stable for 5min — cleared restart state');
            }
        }, 300000);
    }

    _startHealthCheck() {
        if (this._healthCheckInterval) return;
        let consecutiveFailures = 0;
        let consecutiveWsDown = 0;
        const MAX_FAILURES = 3;
        const MAX_WS_DOWN = 5; // 5 checks * 60s = 5 min of WS down while HTTP works

        this._healthCheckInterval = setInterval(async () => {
            try {
                await this.app.client.auth.test();
                consecutiveFailures = 0;

                // Detect blind spot: HTTP OK but WebSocket down
                if (!this.connected) {
                    consecutiveWsDown++;
                    this.logger.warn(`Health check OK but WebSocket down (${consecutiveWsDown}/${MAX_WS_DOWN})`);

                    if (consecutiveWsDown >= MAX_WS_DOWN) {
                        this.logger.warn(`WebSocket down for ${consecutiveWsDown}min despite healthy HTTP — escalating`);
                        this._recordWsError('health_check', `WebSocket down for ${consecutiveWsDown}min while HTTP OK`);
                        consecutiveWsDown = 0;
                    }
                } else {
                    if (consecutiveWsDown > 0) {
                        this.logger.info('WebSocket recovered (health check confirmed)');
                    }
                    consecutiveWsDown = 0;
                }
            } catch (err) {
                consecutiveFailures++;
                consecutiveWsDown = 0; // HTTP also broken — different issue
                this.connected = false;
                if (consecutiveFailures === MAX_FAILURES) {
                    this.logger.warn(`Health check failed ${MAX_FAILURES}x — forcing full restart`);
                    try {
                        await this.app.stop();
                        await this.app.start();
                        this.connected = true;
                        this._setupConnectionMonitor(); // re-attach to new receiver.client
                        consecutiveFailures = 0;
                        this.logger.info('Bolt app restarted successfully via health check');
                    } catch (restartErr) {
                        this.logger.error(`Health check restart failed: ${restartErr.message}`);
                        this._recordWsError('health_check_restart_fail', restartErr.message);
                        consecutiveFailures = 0;
                    }
                }
            }
        }, 60000);
    }

    // ─── WebSocket Error Resilience ────────────────────────────────────

    _loadRestartState() {
        try {
            if (fs.existsSync(this._wsRestartStateFile)) {
                const data = JSON.parse(fs.readFileSync(this._wsRestartStateFile, 'utf8'));
                const cutoff = Date.now() - this._wsRestartWindowMs;
                const timestamps = (data.timestamps || []).filter(ts => ts > cutoff);
                if (timestamps.length > 0) {
                    this.logger.info(`Loaded ${timestamps.length} recent restart(s) from previous process`);
                }
                if (data.pendingRecoveryNotice) {
                    this._pendingRecoveryNotice = {
                        notifiedAt: data.notifiedAt || null,
                        previousErrorCount: data.previousErrorCount || 0,
                        previousRestartsInWindow: data.previousRestartsInWindow || 0,
                    };
                    this.logger.info('Pending recovery notice loaded — will DM owner once WS connection holds');
                }
                return timestamps;
            }
        } catch (err) {
            this.logger.warn(`Failed to load restart state: ${err.message}`);
        }
        return [];
    }

    _saveRestartState(extraFields = {}) {
        try {
            const cutoff = Date.now() - this._wsRestartWindowMs;
            this._wsRestartTimestamps = this._wsRestartTimestamps.filter(ts => ts > cutoff);
            const payload = {
                timestamps: this._wsRestartTimestamps,
                updatedAt: new Date().toISOString(),
                ...extraFields,
            };
            fs.writeFileSync(this._wsRestartStateFile, JSON.stringify(payload));
        } catch (err) {
            this.logger.warn(`Failed to save restart state: ${err.message}`);
        }
    }

    _markPendingRecoveryNotice(errorCount, restartsInWindow) {
        try {
            const cutoff = Date.now() - this._wsRestartWindowMs;
            this._wsRestartTimestamps = this._wsRestartTimestamps.filter(ts => ts > cutoff);
            fs.writeFileSync(this._wsRestartStateFile, JSON.stringify({
                timestamps: this._wsRestartTimestamps,
                updatedAt: new Date().toISOString(),
                pendingRecoveryNotice: true,
                notifiedAt: new Date().toISOString(),
                previousErrorCount: errorCount,
                previousRestartsInWindow: restartsInWindow,
            }));
        } catch (err) {
            this.logger.warn(`Failed to mark pending recovery notice: ${err.message}`);
        }
    }

    _clearRestartState() {
        this._wsRestartTimestamps = [];
        this._pendingRecoveryNotice = null;
        try {
            if (fs.existsSync(this._wsRestartStateFile)) {
                fs.unlinkSync(this._wsRestartStateFile);
            }
        } catch (err) {
            // ignore
        }
    }

    _getRestartsInWindow() {
        const cutoff = Date.now() - this._wsRestartWindowMs;
        this._wsRestartTimestamps = this._wsRestartTimestamps.filter(ts => ts > cutoff);
        return this._wsRestartTimestamps.length;
    }

    _recordWsError(source, message) {
        const now = Date.now();
        this._wsErrors.push(now);

        // Prune events older than the window
        const cutoff = now - this._wsErrorWindowMs;
        this._wsErrors = this._wsErrors.filter(ts => ts > cutoff);

        const count = this._wsErrors.length;
        const restartsInWindow = this._getRestartsInWindow();

        // Escalation uses levels to ensure each stage fires exactly once per incident.
        // On successful connection (stable), levels and restart state reset.
        //
        // Stages 1-2 are based on error count within the current process.
        // Stages 3-4 are based on restart count (persisted to file), so they
        // survive process restarts and catch the restart loop scenario.

        // Stage 1: WARN (5+ errors in 2 min)
        if (count >= 5 && this._wsEscalationLevel < 1) {
            this._wsEscalationLevel = 1;
            this.logger.warn(`WebSocket flapping: ${count} errors in ${this._wsErrorWindowMs / 1000}s [restarts in 10min: ${restartsInWindow}] (latest: ${source}: ${message})`);
        }

        // Stage 2: RESTART Bolt app (10+ errors in 2 min)
        if (count >= 10 && this._wsEscalationLevel < 2) {
            this._wsEscalationLevel = 2;
            this.logger.warn(`WebSocket critical: ${count} errors in window — forcing Bolt restart (restart #${restartsInWindow + 1} in 10min)`);
            this._attemptWsRecoveryRestart();
        }

        // Stage 3: EXIT process (3+ restarts in 10 min — auto-recovery failed)
        // Owner DM only fires here; earlier stages are handled silently since
        // auto-recovery reliably succeeds on restart #1 or #2.
        if (restartsInWindow >= 3 && this._wsEscalationLevel < 3) {
            this._wsEscalationLevel = 3;
            this.logger.error(`WebSocket unrecoverable: ${restartsInWindow} restarts in 10min — exiting process`);
            this._notifyOwnerWsFailure(count, true, restartsInWindow).finally(() => {
                process.exit(1);
            });
        }
    }

    async _attemptWsRecoveryRestart() {
        if (this._wsRestarting) {
            this.logger.debug('WebSocket recovery restart already in progress — skipping');
            return;
        }

        this._wsRestarting = true;

        // Record this restart attempt to file (survives process restarts)
        this._wsRestartTimestamps.push(Date.now());
        this._saveRestartState();

        const restartsInWindow = this._getRestartsInWindow();
        this.logger.warn(`WebSocket recovery restart attempt (${restartsInWindow} in last 10min)`);

        try {
            await this.app.stop();
            await new Promise(r => setTimeout(r, 2000));
            await this.app.start();
            this.connected = true;
            this._setupConnectionMonitor(); // re-attach events to new receiver.client
            this._wsErrors = [];
            // Reset escalation level so _recordWsError can re-evaluate stages.
            // Restart timestamps are NOT reset here — they persist in the file.
            // If WS breaks again quickly, the restart count will trigger NOTIFY/EXIT.
            // Timestamps only clear after 5 min of stable connection (see 'connected' handler).
            this._wsEscalationLevel = 0;
            this.logger.info('WebSocket recovery restart succeeded');
        } catch (err) {
            this.logger.error(`WebSocket recovery restart failed: ${err.message}`);
            if (restartsInWindow >= 2) {
                this.logger.error(`${restartsInWindow} restart failures in 10min — notifying owner and exiting`);
                await this._notifyOwnerWsFailure(this._wsErrors.length, true, restartsInWindow);
                process.exit(1);
            }
        } finally {
            this._wsRestarting = false;
        }
    }

    async _notifyOwnerWsFailure(errorCount, isExiting = false, restartsInWindow = 0) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) {
            this.logger.warn('Cannot notify owner: SLACK_OWNER_USER_ID not configured');
            return;
        }

        const now = Date.now();
        if (!isExiting && now - this._lastOwnerNotifyTs < this._ownerNotifyCooldownMs) {
            this.logger.debug('Owner notification skipped (cooldown)');
            return;
        }
        this._lastOwnerNotifyTs = now;

        const uptimeMin = Math.round((now - this._startedAt) / 60000);
        const restarts = restartsInWindow || this._getRestartsInWindow();
        const action = isExiting
            ? 'Process is exiting for PM2/systemd restart.'
            : 'Restart loop detected — please check the agent.';

        const text = [
            `:rotating_light: *WebSocket Connection Failure*`,
            `*Errors:* ${errorCount} in the last ${this._wsErrorWindowMs / 1000}s`,
            `*Restarts in last 10min:* ${restarts}`,
            `*Uptime:* ${uptimeMin} minutes`,
            `*Action:* ${action}`,
        ].join('\n');

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text,
            });
            this.logger.info('Owner notified of WebSocket failure via DM');
            if (isExiting) {
                this._markPendingRecoveryNotice(errorCount, restarts);
            }
        } catch (err) {
            this.logger.error(`Failed to notify owner: ${err.message}`);
        }
    }

    async _notifyOwnerWsRecovered(prev) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return;

        const downSeconds = prev.notifiedAt
            ? Math.max(0, Math.round((Date.now() - new Date(prev.notifiedAt).getTime()) / 1000))
            : null;
        const downText = downSeconds === null
            ? 'unknown'
            : downSeconds < 90
                ? `${downSeconds}s`
                : `${Math.round(downSeconds / 60)} min`;

        const text = [
            `:white_check_mark: *WebSocket Recovered Automatically*`,
            `*Down for:* ${downText}`,
            `*Previous failure:* ${prev.previousErrorCount} errors / ${prev.previousRestartsInWindow} restarts in 10min`,
            `*Action:* No action needed — system is back to normal.`,
        ].join('\n');

        try {
            await this.app.client.chat.postMessage({ channel: ownerId, text });
            this.logger.info('Owner notified of WebSocket recovery via DM');
        } catch (err) {
            this.logger.error(`Failed to notify owner of recovery: ${err.message}`);
        }
    }

    async _notifyOwnerIncidentWebhook(incidentId, incidentData, { alreadyAcked = false, permalink = null } = {}) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return;

        // If no permalink provided, try to look it up from tracked data
        if (!permalink) {
            const tracked = this.trackedIncidents.get(incidentId);
            if (tracked?.channelId && tracked?.messageTs) {
                permalink = await this._getPermalink(tracked.channelId, tracked.messageTs);
            }
        }

        const title = incidentData?.title || incidentData?.summary || incidentId;
        const urgency = incidentData?.urgency ? ` (${incidentData.urgency})` : '';
        const status = alreadyAcked
            ? 'Already acknowledged via Slack — investigation in progress'
            : 'New incident — starting investigation via webhook';
        const lines = [
            `:bell: *PagerDuty Webhook Received*`,
            `*Incident:* ${title}${urgency}`,
            `*Status:* ${status}`,
        ];
        if (permalink) {
            lines.push(`*Slack thread:* ${permalink}`);
        }

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text: lines.join('\n'),
            });
            this.logger.info(`Owner notified: incident ${incidentId} webhook (alreadyAcked=${alreadyAcked})`);
        } catch (err) {
            this.logger.error(`Failed to notify owner of incident ${incidentId}: ${err.message}`);
        }
    }

    async _notifyOwnerDelayAlert(dagName, taskName, count, { permalink = null } = {}) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return;

        const lines = [
            `:warning: *Airflow Delay Alert — Investigation Started*`,
            `*DAG:* ${dagName}`,
            `*Task:* ${taskName}`,
            `*Alerts:* ${count} in window (threshold reached)`,
        ];
        if (permalink) {
            lines.push(`*Slack thread:* ${permalink}`);
        }

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text: lines.join('\n'),
            });
            this.logger.info(`Owner notified: delay alert for ${dagName}`);
        } catch (err) {
            this.logger.error(`Failed to notify owner of delay alert ${dagName}: ${err.message}`);
        }
    }

    async _publishHome(userId = this.config.ownerUserId, { refreshing = false } = {}) {
        if (!userId) return;
        const state = this._collectHomeState(userId);
        state.refreshing = refreshing;
        const view = buildHomeView(state);
        try {
            await this.app.client.views.publish({ user_id: userId, view });
            // info, not debug: production runs at LOG_LEVEL=info, and a line
            // nobody can see is not a diagnostic. Volume is ~15/hour.
            this.logger.info(
                `home published: user=${userId} blocks=${view.blocks.length}`
                + ` prs=${(state.prTasks || []).length}`
                + (refreshing ? ' (refreshing)' : '')
            );
        } catch (err) {
            this.logger.error(
                `home publish FAILED for ${userId}: ${err.data?.error || err.message}`
            );
            throw err;
        }
    }

    _githubToken() {
        return this.config.githubToken || process.env.GITHUB_TOKEN || '';
    }

    async _githubViewerLogin() {
        if (!this._githubViewerLoginPromise) {
            this._githubViewerLoginPromise = fetchViewerLogin(this._githubToken());
        }
        return this._githubViewerLoginPromise;
    }

    /**
     * Roster of the configured team, cached for the process lifetime. Empty
     * when PR_TEAM is unset, which simply leaves the Team PRs lane empty.
     */
    async _githubTeamMembers() {
        if (!this.config.prTeam) return [];
        if (!this._githubTeamMembersPromise) {
            this._githubTeamMembersPromise = fetchTeamMembers(
                this._githubToken(),
                this.config.prTeam
            ).catch(err => {
                this.logger.warn(
                    `GitHub team roster lookup failed for ${this.config.prTeam}: ${err.message}`
                );
                return [];
            });
        }
        return this._githubTeamMembersPromise;
    }

    /**
     * Teams the owner belongs to, cached for the process lifetime. Needed
     * because a review request aimed at a team never appears in
     * requested_reviewers, and `review-requested:@me` does not match it either.
     */
    async _githubViewerTeams() {
        if (!this._githubViewerTeamsPromise) {
            this._githubViewerTeamsPromise = fetchViewerTeams(this._githubToken())
                .catch(err => {
                    this.logger.warn(
                        `GitHub team lookup failed (team review requests will be missed): ${err.message}`
                    );
                    return [];
                });
        }
        return this._githubViewerTeamsPromise;
    }

    async _detectPrsFromMessage(event) {
        if (!this.config.prBoardEnabled) return [];
        if (event.subtype || event.bot_id || typeof event.text !== 'string') {
            return [];
        }
        const urls = extractPrUrls(event.text);
        if (urls.length === 0) return [];

        const token = this.config.githubToken
            || process.env.GITHUB_TOKEN
            || '';
        if (!token) {
            this.logger.warn('PR board detection skipped: GITHUB_TOKEN is not configured');
            return [];
        }

        const me = await this._githubViewerLogin();
        const myTeams = await this._githubViewerTeams();
        const detected = [];
        for (const pull of urls) {
            try {
                const state = await fetchPrState({
                    repo: pull.repo,
                    number: pull.number,
                    token,
                    viewerLogin: me,
                    viewerTeams: myTeams,
                });
                if (!needsMyReview({
                    requestedReviewers: state.requestedReviewers,
                    requestedTeams: state.requestedTeams,
                    myTeams,
                    me,
                    codeowner: state.codeowner,
                    author: state.author,
                })) {
                    continue;
                }
                detected.push(this.prTasks.upsert({
                    ...pull,
                    title: state.title,
                    author: state.author,
                    ci: state.ci,
                    reviewState: state.reviewState,
                    origin: 'slack',
                    lane: 'review',
                }));
            } catch (err) {
                this.logger.warn(
                    `PR detection failed for ${pull.repo}#${pull.number}: ${err.message}`
                );
            }
        }

        if (detected.length > 0 && this.config.ownerUserId) {
            await this._publishHome(this.config.ownerUserId);
        }
        return detected;
    }

    /**
     * The ts of this PR's DM thread, creating it on first use. The anchor is a
     * header message rather than whichever notification happened to arrive
     * first, so the permalink lands on something that says which PR this is.
     */
    async _prThreadTs(task, channel) {
        if (task.slack_ts) return task.slack_ts;

        const res = await this.app.client.chat.postMessage({
            channel,
            text: `*<${task.url}|${task.repo}#${task.number}>* — ${titleOf(task)}`,
            unfurl_links: false,
            unfurl_media: false,
        });
        let permalink = null;
        try {
            const link = await this.app.client.chat.getPermalink({
                channel,
                message_ts: res.ts,
            });
            permalink = link.permalink || null;
        } catch (err) {
            this.logger.warn(
                `Slack permalink lookup failed for ${task.repo}#${task.number}: ${err.message}`
            );
        }
        this.prTasks.setSlackThread(task.id, res.ts, permalink);
        return res.ts;
    }

    /** Post a message about a PR into that PR's thread. */
    async _postForPr(task, message) {
        const dm = await this.app.client.conversations.open({
            users: this.config.ownerUserId,
        });
        const threadTs = await this._prThreadTs(task, dm.channel.id);
        return this.app.client.chat.postMessage({
            channel: dm.channel.id,
            ...message,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false,
        });
    }

    async _onPaneEvent(job, event) {
        const payload = JSON.parse(job.payload_json || '{}');
        const task = payload.repo && payload.pr
            ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
            : null;
        if (!task) return false;

        const text = String(event.text || '').slice(-1000);
        await this._postForPr(task, {
            text: `:speech_balloon: *#${task.number} session:* ${text}`,
        });
        return true;
    }

    async _relayPrThreadReply(event) {
        if ((this.config.appMode || 'all') === 'local') return false;
        if (!event
            || event.subtype
            || event.bot_id
            || (event.app_id && !event.user)
            || event.user !== this.config.ownerUserId
            || !event.thread_ts
            || typeof event.text !== 'string') {
            return false;
        }

        const task = this.prTasks.bySlackTs(event.thread_ts);
        if (!task || !task.pane_id) return false;
        const job = this.jobs.enqueue('pane_message', {
            pane_id: task.pane_id,
            repo: task.repo,
            pr: task.number,
            text: event.text,
        });
        return Boolean(job);
    }

    async _onJobResult(job) {
        try {
            if (!this.config.ownerUserId) return;
            let dm;
            const postFlat = async message => {
                if (!dm) {
                    dm = await this.app.client.conversations.open({
                        users: this.config.ownerUserId,
                    });
                }
                return this.app.client.chat.postMessage({
                    channel: dm.channel.id,
                    ...message,
                    unfurl_links: false,
                    unfurl_media: false,
                });
            };
            if (job.kind === 'review') {
                await postFlat({
                    text: 'Review draft ready',
                    blocks: buildReviewResultBlocks(job),
                });
            } else if (job.kind === 'apex_review') {
                const task = this.prTasks.listActive().find(
                    row => Number(row.draft_job_id) === Number(job.id)
                );
                if (!task) {
                    this.logger.warn(
                        `apex review job ${job.id} has no linked active PR task`
                    );
                    return;
                }
                const result = JSON.parse(job.result_json || '{}');
                if (result.pane_id) {
                    this.prTasks.setPane(task.id, result.pane_id);
                }
                this.prTasks.setStatus(task.id, 'drafted');
                const drafted = this.prTasks.get(task.id);
                await this._postForPr(drafted, {
                    text: `Apex review draft ready for ${task.repo}#${task.number}`,
                    blocks: buildPrDraftResultBlocks(drafted, job),
                });
                await this._publishHome(this.config.ownerUserId);
            } else if (job.kind === 'merge_pr') {
                const result = JSON.parse(job.result_json || '{}');
                const payload = JSON.parse(job.payload_json || '{}');
                const task = payload.repo && payload.pr
                    ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
                    : null;
                const message = {
                    text: `:rocket: Merged (${result.method || 'squash'}): ${result.url || ''}`.trim(),
                };
                await (task
                    ? this._postForPr(task, message)
                    : postFlat(message));
                // The next sweep sees state=closed and retires the row, but
                // repaint now so the button cannot be pressed twice.
                await this._publishHome(this.config.ownerUserId);
            } else if (job.kind === 'pane_message') {
                // The reviewer did the work; report what it said rather than
                // claiming an outcome this side never observed.
                const result = JSON.parse(job.result_json || '{}');
                const payload = JSON.parse(job.payload_json || '{}');
                const where = payload.repo && payload.pr
                    ? `${payload.repo}#${payload.pr}`
                    : 'the PR';
                const task = payload.repo && payload.pr
                    ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
                    : null;
                const message = {
                    text: `:white_check_mark: Reviewer finished on *${where}*`
                        + (result.tail ? `\n\`\`\`${result.tail.slice(-1000)}\`\`\`` : ''),
                };
                await (task
                    ? this._postForPr(task, message)
                    : postFlat(message));
                await this._publishHome(this.config.ownerUserId);
            } else if (job.kind === 'address_comments') {
                const result = JSON.parse(job.result_json || '{}');
                const payload = JSON.parse(job.payload_json || '{}');
                const where = payload.repo && payload.pr
                    ? `${payload.repo}#${payload.pr}`
                    : 'the PR';
                const task = payload.repo && payload.pr
                    ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
                    : null;
                if (task && result.pane_id) {
                    this.prTasks.setPane(task.id, result.pane_id);
                }
                const pane = result.pane_id
                    ? ` in pane \`${result.pane_id}\``
                    : '';
                const message = {
                    text: (result.reply_written
                        ? `:white_check_mark: Finished addressing comments on *${where}*${pane}`
                        : `:warning: Comment-addressing session on *${where}* stopped without writing its reply draft${pane}. The pane is still live and may be waiting on the owner.`)
                        + (result.tail ? `\n\`\`\`${result.tail.slice(-1000)}\`\`\`` : ''),
                };
                await (task
                    ? this._postForPr(task, message)
                    : postFlat(message));
                await this._publishHome(this.config.ownerUserId);
            } else if (job.kind === 'pane_close') {
                const payload = JSON.parse(job.payload_json || '{}');
                const task = payload.repo && payload.pr
                    ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
                    : null;
                if (task) {
                    this.prTasks.setPane(task.id, null);
                }
                const message = {
                    text: ':door: Review session closed. Nothing was posted.',
                };
                await (task
                    ? this._postForPr(task, message)
                    : postFlat(message));
            }
        } catch (err) {
            this.logger.error(`_onJobResult failed for job ${job.id}: ${err.message}`);
        }
    }

    /**
     * A job the queue has given up on. Until this existed a dead review was
     * indistinguishable from one that was never started: the error sat in
     * SQLite and the PR row stayed at 'reviewing' with no button, so the only
     * way to find out was to SSH in and read the jobs table.
     */
    async _onJobFailed(job) {
        try {
            const payload = JSON.parse(job.payload_json || '{}');
            const label = payload.repo && payload.pr
                ? `${payload.repo}#${payload.pr}`
                : `job ${job.id}`;

            if (job.kind === 'apex_review') {
                const task = this.prTasks.listActive().find(
                    row => Number(row.draft_job_id) === Number(job.id)
                );
                if (task) this.prTasks.failDraft(task.id);
            }

            this.logger.error(
                `job ${job.id} (${job.kind}) failed for ${label} after `
                    + `${job.attempts} attempt(s): ${job.error}`
            );

            if (!this.config.ownerUserId) return;
            const task = payload.repo && payload.pr
                ? this.prTasks.byRepoNumber(payload.repo, payload.pr)
                : null;
            const message = {
                text: `:x: \`${job.kind}\` gave up on *${label}* after `
                    + `${job.attempts} attempt(s)\n`
                    + '```' + String(job.error || 'no error recorded').slice(0, 800) + '```',
            };
            if (task) {
                await this._postForPr(task, message);
            } else {
                const dm = await this.app.client.conversations.open({
                    users: this.config.ownerUserId,
                });
                await this.app.client.chat.postMessage({
                    channel: dm.channel.id,
                    ...message,
                    unfurl_links: false,
                    unfurl_media: false,
                });
            }
            await this._publishHome(this.config.ownerUserId);
        } catch (err) {
            this.logger.error(`_onJobFailed failed for job ${job.id}: ${err.message}`);
        }
    }

    _setupListeners() {
        const mode = this.config.appMode || 'all';

        this.app.event('app_mention', async ({ event, say }) => {
            try {
                // Dedup: both app_mention and message events fire for the same @mention
                if (!this._handledMentionTs) this._handledMentionTs = new Set();
                if (this._handledMentionTs.has(event.ts)) return;
                this._handledMentionTs.add(event.ts);

                // cloud mode: only handle mentions in monitored channels (alert threads)
                // local mode: only handle mentions in non-monitored channels (main chat)
                // This prevents duplicate responses when both instances receive the same event
                if (mode === 'cloud' || mode === 'local') {
                    const channelId = event.channel;
                    const isMonitorChannel = this.alertMonitor.isMonitoredChannel(channelId) || this.delayAlertMonitor.isMonitoredChannel(channelId);
                    if (mode === 'cloud' && !isMonitorChannel) {
                        this.logger.info(`App mode=cloud: ignoring mention in non-monitor channel ${channelId}`);
                        return;
                    }
                    if (mode === 'local' && isMonitorChannel) {
                        this.logger.info(`App mode=local: ignoring mention in monitor channel ${channelId}`);
                        return;
                    }
                }
                await this._handleMention(event, say);
            } catch (err) {
                if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                    this.logger.warn(`Mention handler failed (disconnected): ${err.message}`);
                } else {
                    throw err;
                }
            }
        });

        // Monitor channels + delay alerts: enabled in 'cloud' and 'all' modes
        if (mode !== 'local') {
            this.app.event('message', async ({ event, say }) => {
                try {
                    // A deleted message that spawned a session leaves an orphan:
                    // its thread root is gone, so the session's Stop-hook /
                    // ask_user posts target a dead thread_ts and Slack silently
                    // reroutes them to the channel root, where they read as
                    // stray, unanswered messages. Reap the session so it stops
                    // computing and posting into the void.
                    if (event.subtype === 'message_deleted') {
                        const deletedTs = event.deleted_ts || event.previous_message?.ts;
                        this._reapOrphanedSession(event.channel, deletedTs);
                        return;
                    }

                    if (await this._relayPrThreadReply(event)) return;

                    // Owner DM keyword: "reseed" → mint a fresh SSO device-code
                    // URL on demand (same as tapping the button on an SSO DM).
                    if (event.channel_type === 'im' && !event.subtype && !event.bot_id
                        && event.user && event.user === this.config.ownerUserId
                        && typeof event.text === 'string' && /(^|\s)reseed(\s|$)/i.test(event.text)) {
                        if (this.ssoPrewarm) {
                            try {
                                await this.ssoPrewarm.reseedNow('keyword');
                            } catch (err) {
                                this.logger.error(`Keyword re-seed failed: ${err.message}`);
                                await this.app.client.chat.postMessage({ channel: event.channel, text: `:x: Re-seed failed: ${err.message}` });
                            }
                        }
                        return;
                    }

                    // Entity Plan H: detect PR URLs without delaying the Slack
                    // listener. GitHub failures are logged inside the task.
                    if (this.config.prBoardEnabled) {
                        this._detectPrsFromMessage(event).catch(err =>
                            this.logger.warn(
                                `PR message detection failed: ${err.message}`
                            )
                        );
                    }

                    // Handle @mentions that arrive as 'message' instead of 'app_mention'
                    // (happens when multiple Socket Mode connections exist, or with Assistants API)
                    if (!event.subtype && event.text && event.text.includes(`<@`) && !event.bot_id) {
                        // Resolve bot user ID lazily
                        if (!this._botUserId) {
                            try {
                                this._botUserId = (await this.app.client.auth.test()).user_id;
                            } catch { /* ignore */ }
                        }
                        if (this._botUserId && event.text.includes(`<@${this._botUserId}>`)) {
                            // Dedup: skip if app_mention already handled this event
                            if (!this._handledMentionTs) this._handledMentionTs = new Set();
                            if (this._handledMentionTs.has(event.ts)) return;
                            this._handledMentionTs.add(event.ts);
                            // Prevent unbounded growth
                            if (this._handledMentionTs.size > 200) {
                                const arr = [...this._handledMentionTs];
                                this._handledMentionTs = new Set(arr.slice(-100));
                            }
                            this.logger.info(`Message-as-mention fallback for ts=${event.ts}`);
                            await this._handleMention(event, say);
                            return;
                        }
                    }
                    // DM slash commands (/whygraph, /search) in message events
                    if (event.channel_type === 'im' && event.text?.startsWith('/') && !event.bot_id) {
                        if (!(await this.accessControl.isAllowed(event.user))) {
                            this.logger.info(`Access denied (DM graph command) | user=${event.user}`);
                            return;
                        }
                        try {
                            const reply = await graphHandleCommand({
                                text: event.text, channel: event.channel, user: event.user,
                            });
                            await this.app.client.chat.postMessage({ channel: event.channel, text: reply });
                        } catch (err) {
                            this.logger.warn(`graph DM command (message event) failed: ${err.message}`);
                        }
                        return;
                    }

                    await this._handleMonitoredMessage(event);
                    await this._handleDelayAlertMessage(event);

                    // T11: Graph-ingest forwarder — fire-and-forget, never block Slack delivery
                    if (process.env.GRAPH_INGEST_ENABLED === 'true') {
                        graphIngest.handle(event, this.app.client).catch(err =>
                            this.logger.debug(`graph-ingest handle failed: ${err.message}`)
                        );
                    }
                } catch (err) {
                    if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                        this.logger.warn(`Message handler failed (disconnected): ${err.message}`);
                    } else {
                        throw err;
                    }
                }
            });
        } else {
            this.logger.info('App mode=local: monitor channels and delay alerts disabled');
        }

        // On-demand SSO re-seed button (rendered on the SSO DMs). Both local and
        // cloud instances receive the click via Socket Mode, but only the one
        // actually running the prewarm watcher (`this.ssoPrewarm`) acts on it.
        this.app.action('sso_reseed_now', async ({ ack, body }) => {
            await ack();
            if (!this.ssoPrewarm) return; // wrong instance (e.g. APP_MODE=local)
            const userId = body && body.user && body.user.id;
            if (this.config.ownerUserId && userId && userId !== this.config.ownerUserId) return;
            // Minting a device code takes a few seconds. A button that stays
            // silent that long invites repeat taps, and each tap used to DM
            // another URL (3 near-identical DMs in 30s on 2026-07-26). Report
            // progress on the tapped message itself; SsoPrewarm collapses the
            // extra taps so at most one new DM comes out.
            const dmChannel = body.channel && body.channel.id;
            const dmTs = body.message && body.message.ts;
            const dmText = (body.message && body.message.text) || '';
            await this.ssoPrewarm.repaintDm(
                dmChannel, dmTs, dmText, ':hourglass_flowing_sand: _Minting a fresh URL…_'
            );
            try {
                const result = await this.ssoPrewarm.reseedNow('button');
                const code = (result && result.user_code) || 'unknown';
                await this.ssoPrewarm.repaintDm(dmChannel, dmTs, dmText, result && result.dmSent
                    ? `:white_check_mark: _Fresh URL sent below (code \`${code}\`)._`
                    : `:information_source: _Already re-seeding — approve code \`${code}\` from the newest DM._`);
            } catch (err) {
                this.logger.error(`Re-seed button failed: ${err.message}`);
                // Put the button back so the operator can retry from here.
                await this.ssoPrewarm.repaintDm(dmChannel, dmTs, dmText, null);
                try {
                    await this.app.client.chat.postMessage({
                        channel: userId || this.config.ownerUserId,
                        text: `:x: Re-seed failed: ${err.message}`,
                    });
                } catch { /* ignore */ }
            }
        });

        for (const actionId of ['job_post_review', 'job_discard']) {
            this.app.action(actionId, async ({ ack, body, action }) => {
                await ack();
                const userId = body.user && body.user.id;
                if (this.config.ownerUserId
                    && userId !== this.config.ownerUserId) {
                    return;
                }
                try {
                    const reply = await handleJobAction({
                        actionId,
                        value: action.value,
                        jobs: this.jobs,
                    });
                    await this.app.client.chat.postMessage({
                        channel: body.channel.id,
                        text: reply,
                        unfurl_links: false,
                        unfurl_media: false,
                    });
                } catch (err) {
                    this.logger.error(`job action ${actionId} failed: ${err.message}`);
                }
            });
        }

        // 🔗 Open is a plain URL button — Slack still dispatches an
        // interaction for it, so ack it or Bolt logs an unhandled request.
        this.app.action('pr_open', async ({ ack }) => { await ack(); });

        // Overflow menu on table rows. The selected option's value carries the
        // action id, so this dispatches into the same handlers as the buttons.
        this.app.action('pr_menu', async ({ ack, body, action }) => {
            await ack();
            const userId = body.user && body.user.id;
            if (this.config.ownerUserId
                && userId !== this.config.ownerUserId) {
                return;
            }
            const [actionId, taskId] = String(
                action.selected_option?.value || ''
            ).split(':');
            if (!actionId || !taskId) return;
            // pr_thread and pr_open are both pure links: Slack has already
            // opened the option's url by the time this fires.
            if (actionId === 'pr_open' || actionId === 'pr_thread') return;

            try {
                const task = this.prTasks.get(Number(taskId));
                const reply = await handlePrAction({
                    actionId,
                    value: taskId,
                    prTasks: this.prTasks,
                    jobs: this.jobs,
                    agentSessions: this.agentSessions,
                });
                const message = {
                    ...(typeof reply === 'string' ? { text: reply } : reply),
                };
                if (task) {
                    await this._postForPr(task, message);
                } else {
                    const dm = await this.app.client.conversations.open({
                        users: userId || this.config.ownerUserId,
                    });
                    await this.app.client.chat.postMessage({
                        channel: dm.channel.id,
                        ...message,
                        unfurl_links: false,
                        unfurl_media: false,
                    });
                }
                await this._publishHome(userId || this.config.ownerUserId);
            } catch (err) {
                this.logger.error(
                    `PR menu action ${actionId} failed: ${err.message}`
                );
            }
        });

        // pr_edit is not here: it opens a modal instead of acting directly, and
        // the action it eventually takes (pr_revise) arrives as a view submission.
        const prActionIds = [
            'pr_review_now',
            'pr_post',
            'pr_discard',
            'pr_dismiss',
            'pr_merge',
            'pr_process_with',
        ];
        for (const actionId of prActionIds) {
            this.app.action(actionId, async ({ ack, body, action }) => {
                await ack();
                const userId = body.user && body.user.id;
                if (this.config.ownerUserId
                    && userId !== this.config.ownerUserId) {
                    return;
                }
                try {
                    const taskId = String(action.value).split(':')[0];
                    const task = this.prTasks.get(Number(taskId));
                    const reply = await handlePrAction({
                        actionId,
                        value: action.value,
                        prTasks: this.prTasks,
                        jobs: this.jobs,
                        agentSessions: this.agentSessions,
                    });
                    const message = {
                        // Same shape as the pr_menu path: a handler may answer
                        // with blocks instead of a line, and passing that object
                        // as `text` fails at Slack rather than here.
                        ...(typeof reply === 'string' ? { text: reply } : reply),
                    };
                    if (task) {
                        await this._postForPr(task, message);
                    } else {
                        const dm = await this.app.client.conversations.open({
                            users: userId || this.config.ownerUserId,
                        });
                        await this.app.client.chat.postMessage({
                            channel: dm.channel.id,
                            ...message,
                            unfurl_links: false,
                            unfurl_media: false,
                        });
                    }
                    await this._publishHome(
                        userId || this.config.ownerUserId
                    );
                } catch (err) {
                    this.logger.error(
                        `PR action ${actionId} failed: ${err.message}`
                    );
                }
            });
        }

        // Edit opens a modal rather than acting: the reviewer is still live in
        // its pane holding the full context, so what it needs is instructions,
        // not a rewritten body pasted back at it.
        this.app.action('pr_edit', async ({ ack, body, action }) => {
            await ack();
            const userId = body.user && body.user.id;
            if (this.config.ownerUserId && userId !== this.config.ownerUserId) {
                return;
            }
            const task = this.prTasks.get(Number(action.value));
            if (!task) return;
            try {
                await this.app.client.views.open({
                    trigger_id: body.trigger_id,
                    view: {
                        type: 'modal',
                        callback_id: 'pr_revise_modal',
                        private_metadata: String(task.id),
                        title: { type: 'plain_text', text: 'Revise review' },
                        submit: { type: 'plain_text', text: 'Send & post' },
                        close: { type: 'plain_text', text: 'Cancel' },
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `*${task.repo}#${task.number}*\n${task.title || ''}`,
                                },
                            },
                            {
                                type: 'input',
                                block_id: 'revise',
                                label: { type: 'plain_text', text: 'What should change?' },
                                hint: {
                                    type: 'plain_text',
                                    text: 'Goes straight to the reviewer, which then posts the revised review.',
                                },
                                element: {
                                    type: 'plain_text_input',
                                    action_id: 'text',
                                    multiline: true,
                                    placeholder: {
                                        type: 'plain_text',
                                        text: 'e.g. drop the nit, keep suggestions 1 and 3, and shorten the body',
                                    },
                                },
                            },
                        ],
                    },
                });
            } catch (err) {
                this.logger.error(`pr_edit modal failed: ${err.message}`);
            }
        });

        this.app.view('pr_revise_modal', async ({ ack, body, view }) => {
            await ack();
            const userId = body.user && body.user.id;
            if (this.config.ownerUserId && userId !== this.config.ownerUserId) {
                return;
            }
            try {
                const task = this.prTasks.get(Number(view.private_metadata));
                const reply = await handlePrAction({
                    actionId: 'pr_revise',
                    value: view.private_metadata,
                    prTasks: this.prTasks,
                    jobs: this.jobs,
                    agentSessions: this.agentSessions,
                    instructions: view.state.values.revise.text.value || '',
                });
                const message = {
                    text: reply,
                };
                if (task) {
                    await this._postForPr(task, message);
                } else {
                    const dm = await this.app.client.conversations.open({
                        users: userId || this.config.ownerUserId,
                    });
                    await this.app.client.chat.postMessage({
                        channel: dm.channel.id,
                        ...message,
                        unfurl_links: false,
                        unfurl_media: false,
                    });
                }
                await this._publishHome(userId || this.config.ownerUserId);
            } catch (err) {
                this.logger.error(`pr_revise failed: ${err.message}`);
            }
        });

        // Entity: on-demand board refresh. Re-sweeps GitHub and re-reads PR
        // state now instead of waiting for the next monitor cycle, then
        // repaints. Owner-only, like every other board action.
        // home_refresh is page-level: it re-sweeps everything the page shows.
        // pr_refresh stays registered so a Home tab published before this
        // rename still works when tapped.
        const onRefresh = async ({ ack, body }) => {
            await ack();
            const userId = body.user && body.user.id;
            if (this.config.ownerUserId
                && userId !== this.config.ownerUserId) {
                return;
            }
            const target = userId || this.config.ownerUserId;
            try {
                const token = this.config.githubToken
                    || process.env.GITHUB_TOKEN
                    || '';
                if (!token) {
                    this.logger.warn('pr_refresh: no GitHub token configured');
                    await this._publishHome(target);
                    return;
                }
                // A full refresh is ~10s of round trips, so say so immediately
                // rather than leaving the tap looking ignored.
                await this._publishHome(target, { refreshing: true })
                    .catch(() => {});

                const viewerLogin = await this._githubViewerLogin()
                    .catch(() => null);
                const teams = await this._githubViewerTeams();
                const members = await this._githubTeamMembers();
                const org = this.config.prOrg || '';
                await sweepReviewRequests(this.prTasks, token, {
                    teams, viewerLogin, org,
                });
                await sweepMyPrs(this.prTasks, token, { org });
                if (members.length) {
                    await sweepTeamPrs(this.prTasks, token, {
                        members, viewerLogin, org,
                    });
                }
                // The sweeps settle which PRs exist; publish that before the
                // slower per-PR detail pass so the row set updates early.
                await this._publishHome(target, { refreshing: true })
                    .catch(() => {});

                await refreshAll(this.prTasks, token, viewerLogin, teams);
                await refreshMine(this.prTasks, token, viewerLogin);
            } catch (err) {
                this.logger.error(`pr_refresh failed: ${err.message}`);
            }
            // Repaint regardless, so a failed sweep still shows current rows.
            await this._publishHome(target).catch(() => {});
        };
        this.app.action('home_refresh', onRefresh);
        this.app.action('pr_refresh', onRefresh);

        // Draft visibility. A pure view preference — no re-sweep, since draft
        // status is already on every row.
        this.app.action('home_toggle_drafts', async ({ ack, body, action }) => {
            await ack();
            const userId = body.user && body.user.id;
            if (this.config.ownerUserId
                && userId !== this.config.ownerUserId) {
                return;
            }
            try {
                this.prTasks.setPref(
                    'show_drafts',
                    action.value === 'show' ? 'true' : 'false'
                );
                await this._publishHome(userId || this.config.ownerUserId);
            } catch (err) {
                this.logger.error(`home_toggle_drafts failed: ${err.message}`);
            }
        });

        // Entity: App Home status board. Repaint whenever the user opens the tab.
        this.app.event('app_home_opened', async ({ event }) => {
            if (event.tab && event.tab !== 'home') return;
            try {
                await this._publishHome(event.user);
            } catch (err) {
                this.logger.warn(`home tab publish failed: ${err.message}`);
            }
        });
    }

    /**
     * Active PR rows for the board, minus drafts unless the owner asked to see
     * them. Filtered at render time rather than at sweep time, so toggling is
     * instant and needs no GitHub round trip.
     */
    _collectPrRows() {
        const rows = this.prTasks.listActive();
        const showDrafts = this.prTasks.getPref('show_drafts', 'false') === 'true';
        if (showDrafts) {
            return { prTasks: rows, showDrafts: true, draftsHidden: 0 };
        }
        const kept = rows.filter(row => !row.is_draft);
        return {
            prTasks: kept,
            showDrafts: false,
            draftsHidden: rows.length - kept.length,
        };
    }

    /** Gather live state for the App Home board (owner sees internals). */
    _collectHomeState(userId) {
        const rows = this._stmts.all.all();
        return {
            isOwner: Boolean(this.config.ownerUserId) && userId === this.config.ownerUserId,
            uptimeSec: process.uptime(),
            sessions: rows.map(r => ({
                name: r.session_name,
                cliType: r.cli_type || 'claude',
                repoPath: r.repo_path,
                alive: this._isTmuxSessionAlive(r.session_name),
                updatedAt: r.updated_at,
            })),
            queue: {
                pending: this._queueStmts.countPending.get().count,
                processing: this._queueStmts.countProcessing.get().count,
            },
            ...this._collectPrRows(),
            schedules: { dailySummaryTime: this.config.dailySummaryChannels ? this.config.dailySummaryTime : null },
        };
    }

    async _handleMonitoredMessage(event) {
        // Filter out message edits and subtypes (joins, topic changes, etc.)
        if (event.subtype) return;

        // Skip thread replies — PD sends status updates as thread replies
        if (event.thread_ts && event.thread_ts !== event.ts) return;

        const channelId = event.channel;
        if (!this.alertMonitor.isMonitoredChannel(channelId)) return;

        // Detect PagerDuty messages
        if (!this.alertMonitor.isPagerDutyMessage(event)) return;

        // Skip status notifications (Acknowledged, Resolved)
        if (this.alertMonitor.isStatusNotification(event)) {
            this.logger.info(`Skipping PD status notification in ${channelId}: ${(event.text || '').substring(0, 80)}`);
            return;
        }

        const messageTs = event.ts;
        const text = event.text || '';
        const incidentId = this.alertMonitor.extractIncidentId(event);

        this.logger.info(`PagerDuty alert detected in ${channelId}: incident=${incidentId || 'unknown'} ts=${messageTs}`);

        // Dedup by incident ID
        if (incidentId && this.trackedIncidents.has(incidentId)) {
            this.logger.info(`Skipping duplicate incident ${incidentId}`);
            return;
        }

        // Dedup by session key (already being investigated in this thread)
        const sessionKey = `${channelId}-${messageTs}`;
        if (this._getSession(sessionKey)) {
            this.logger.info(`Skipping: session already exists for ${sessionKey}`);
            return;
        }

        if (incidentId) this.trackedIncidents.set(incidentId, { channelId, messageTs });

        // PD acknowledge — only skip if resolved (no point investigating).
        // "acknowledged" is normal: the webhook ACKs PD before Socket Mode fires.
        if (incidentId && this.config.pagerdutyApiToken) {
            const pdResult = await this._acknowledgePagerDuty(incidentId);
            if (pdResult?.skipped && pdResult?.status === 'resolved') {
                this.logger.info(`PD incident ${incidentId} already resolved — skipping investigation`);
                if (incidentId) this.trackedIncidents.delete(incidentId);
                return;
            }
        }

        // Ack-only kill switch: when ALERT_ACK_ONLY=true the bot acknowledges
        // the PD incident (above) but skips the investigation pipeline. Used
        // during incident storms to stop spawning tmux sessions.
        if (process.env.ALERT_ACK_ONLY === 'true') {
            this.logger.info(`ALERT_ACK_ONLY=true — acked incident ${incidentId || 'unknown'}, skipping investigation`);
            await this._addReaction(channelId, messageTs, 'no_entry').catch(() => {});
            if (incidentId) this.trackedIncidents.delete(incidentId);
            return;
        }

        // Download attached images
        const imagePaths = await this._downloadSlackImages(event.files, `alert-${messageTs.replace('.', '')}`);
        const imageInstruction = imagePaths.length > 0
            ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
            : '';

        // Build prompt via the first CLI in the configured chain. The alert
        // prompt syntax is identical across Claude and Codex (both use
        // `execute X skill with argument Y`), so the first CLI in the chain
        // is a safe stand-in even if we end up falling back to a later entry.
        const permalink = await this._getPermalink(channelId, messageTs);
        const alertSkill = this.config.alertSkill;
        const alertCliChain = this.config.alertCliChain || ['claude'];
        const alertAdapter = getCliAdapter(alertCliChain[0]);
        const prompt = alertAdapter.buildAlertPrompt({
            skill: alertSkill,
            permalink,
            fallbackText: text,
            imageInstruction,
            fallbackIntro: 'Investigate this PagerDuty alert',
        });

        // Enqueue for sequential processing — prevents resource contention from concurrent sessions
        const position = this._enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType: 'pagerduty' });
        const activeSlots = this._queueStmts.countProcessing.get().count;
        const maxConcurrent = this.config.alertMaxConcurrent || 1;
        const canStartNow = position === 1 && activeSlots < maxConcurrent;

        if (canStartNow) {
            await this._addReaction(channelId, messageTs, 'eyes');
        } else if (position > 0) {
            // Queued — react with hourglass (swapped to eyes when dequeued)
            await this._addReaction(channelId, messageTs, 'hourglass_flowing_sand');
            await this.app.client.chat.postMessage({
                channel: channelId, text: `\u23f3 Queued for investigation (position ${position}, ${activeSlots}/${maxConcurrent} slots busy)`, thread_ts: messageTs
            }).catch(() => {});
        }
        this._processNextInQueue();
    }

    async _handleDelayAlertMessage(event) {
        // Allow bot_message (Airflow-Bot posts via integration), filter edits/deletes/etc.
        if (event.subtype && event.subtype !== 'bot_message') return;

        const channelId = event.channel;
        if (!this.delayAlertMonitor.isMonitoredChannel(channelId)) return;

        // Detect Airflow delay alerts
        if (!this.delayAlertMonitor.isAirflowDelayAlert(event)) {
            this.logger.debug(`Delay monitor: message in monitored channel not an Airflow alert, skipping ts=${event.ts}`);
            return;
        }

        const alertInfo = this.delayAlertMonitor.extractAlertInfo(event);
        if (!alertInfo) {
            this.logger.warn(`Delay monitor: detected Airflow alert but failed to extract task/dag, ts=${event.ts}`);
            return;
        }

        // Check task pattern match
        if (!this.delayAlertMonitor.matchesTaskPattern(alertInfo.task)) return;

        const messageTs = event.ts;

        // Dedup: Slack Socket Mode can redeliver the same event (WebSocket reconnect,
        // multiple connections, retry-on-no-ACK). Without this guard a single Airflow
        // alert can be counted multiple times and falsely trip the threshold.
        if (!this._handledDelayTs) this._handledDelayTs = new Set();
        if (this._handledDelayTs.has(messageTs)) {
            this.logger.info(`Delay alert dedup: skipping redelivery of ts=${messageTs}`);
            return;
        }
        this._handledDelayTs.add(messageTs);
        if (this._handledDelayTs.size > 200) {
            this._handledDelayTs = new Set([...this._handledDelayTs].slice(-100));
        }

        // Increment counter (persisted to SQLite) — incrementCounter logs the N/threshold progress
        const { count, triggered } = this.delayAlertMonitor.incrementCounter(alertInfo.dag, channelId, messageTs);

        if (!triggered) {
            this.logger.info(`Delay alert ${count}/${this.delayAlertMonitor.threshold}: dag=${alertInfo.dag} task=${alertInfo.task} — waiting for more`);
            return;
        }

        // Threshold reached — trigger investigation
        this.logger.info(`Delay alert ${count}/${this.delayAlertMonitor.threshold}: dag=${alertInfo.dag} task=${alertInfo.task} — threshold reached, starting investigation`);

        // Dedup: check if we already have a session for this message
        const sessionKey = `${channelId}-${messageTs}`;
        if (this._getSession(sessionKey)) {
            this.logger.info(`Skipping: session already exists for ${sessionKey}`);
            return;
        }

        // React with eyes on the triggering message
        await this._addReaction(channelId, messageTs, 'eyes');

        // Download attached images (if any — Airflow alerts are usually text-only)
        const imagePaths = await this._downloadSlackImages(event.files, `delay-alert-${messageTs.replace('.', '')}`);
        const imageInstruction = imagePaths.length > 0
            ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
            : '';

        // Build prompt via the first CLI in DELAY_ALERT_CLI (prompt syntax is
        // CLI-agnostic, so falling back later is safe).
        const text = event.text || '';
        const permalink = await this._getPermalink(channelId, messageTs);
        const skill = this.delayAlertMonitor.skill;
        const delayCliChain = this.config.delayAlertCliChain || ['claude'];
        const delayAdapter = getCliAdapter(delayCliChain[0]);
        const prompt = delayAdapter.buildAlertPrompt({
            skill,
            permalink,
            fallbackText: text,
            imageInstruction,
            fallbackIntro: 'Investigate this Airflow delay alert',
        });

        // Reset counter after triggering (so it can accumulate again)
        this.delayAlertMonitor.resetCounter(alertInfo.dag);

        // DM owner that investigation is starting
        this._notifyOwnerDelayAlert(alertInfo.dag, alertInfo.task, count, { permalink }).catch(err =>
            this.logger.error(`Failed to notify owner of delay alert: ${err.message}`)
        );

        // Use the regular command flow — messageTs as threadTs
        await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs, null, delayCliChain);
    }

    async _getPermalink(channelId, messageTs) {
        try {
            const result = await this.app.client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
            return result.permalink;
        } catch (error) {
            this.logger.error(`Failed to get permalink: ${error.message}`);
            return null;
        }
    }

    async _handleMention(event, say) {
        const userId = event.user;
        const channelId = event.channel;
        const threadTs = event.thread_ts || event.ts;
        const rawText = event.text || '';

        this.logger.info(`Mention received | user=${userId} channel=${channelId} thread=${threadTs} text="${rawText.substring(0, 100)}"`);

        // Access gate: when locked down (SLACK_ALLOWED_SUBTEAMS / SLACK_WHITELIST
        // set), only the owner and allowed team members may talk to the bot.
        // Fails closed (owner-only) if subteam membership can't be resolved.
        if (!(await this.accessControl.isAllowed(userId))) {
            this.logger.info(`Access denied | user=${userId} channel=${channelId} — not owner or allowed subteam member`);
            const owner = this.config.ownerUserId ? ` Ping <@${this.config.ownerUserId}> if you need access.` : '';
            await say({ text: `:no_entry: Sorry, EnzoBot is limited to Enzo's team.${owner}`, thread_ts: threadTs });
            return;
        }
        // Restricted = allowed but not the owner. Their session gets a boundary
        // block that forbids disclosing personal / server info.
        const restricted = this.accessControl.isRestricted(userId);
        // Write-authorized = owner or a member of a write-authorized subteam
        // (SLACK_WRITE_SUBTEAMS). They may direct repo write actions (PR
        // approve/merge, push) under the bot's git identity. Every other allowed
        // teammate can chat but not trigger writes under the owner's identity.
        const writeAuthorized = await this.accessControl.isWriteAuthorized(userId);
        // Resolve the sender's display name so the injected prompt can tell the
        // model WHO sent this turn (see _senderIdentityHeader). Cached; best-effort.
        const senderName = await this._resolveSenderName(userId);

        let text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

        // DM slash commands: route /whygraph and /search before any other handling.
        // Match only the graph commands — a bare `text.startsWith('/')` here
        // swallowed every other slash (/exit, /quit, /status, /model, …) and
        // replied "Unknown command", stopping them from reaching their real
        // handlers (session teardown, local TUI commands) further down.
        const GRAPH_DM_COMMANDS = /^\/(whygraph|search)(\s|$)/;
        if (event.channel_type === 'im' && GRAPH_DM_COMMANDS.test(text)) {
            try {
                const reply = await graphHandleCommand({ text, channel: channelId, user: userId });
                await this.app.client.chat.postMessage({ channel: channelId, text: reply, thread_ts: threadTs });
            } catch (err) {
                this.logger.warn(`graph DM command failed: ${err.message}`);
                await say({ text: `Graph command error: ${err.message}`, thread_ts: threadTs });
            }
            return;
        }

        // Download any attached images and append file paths to the message
        const imagePaths = await this._downloadSlackImages(event.files, `slack-${channelId}-${threadTs.replace('.', '')}`);
        if (imagePaths.length > 0) {
            const imageRef = `\nAttached images (read these files for visual context): ${imagePaths.join(' ')}`;
            text = text ? text + imageRef : `Please analyze these images: ${imagePaths.join(' ')}`;
        }

        if (!text) {
            await say({ text: 'Please provide a message after mentioning me.', thread_ts: threadTs });
            return;
        }

        // Manual override: "investigate now" inside an alert thread claims the
        // queued row and starts the investigation immediately, bypassing the
        // alertMaxConcurrent cap. Falls through to normal chat if no pending
        // row matches (e.g. already running, or not an alert thread at all).
        if (INVESTIGATE_NOW_RE.test(text)) {
            const promoted = await this._tryPromoteQueuedAlert({ channelId, threadTs, text, userId, say });
            if (promoted) return;
        }

        const sessionKey = `${channelId}-${threadTs}`;
        const activeSession = this._getSession(sessionKey);
        const firstToken = text.split(/\s/)[0];
        const localCommand = _adapterLocalSlashCommand(activeSession ? (activeSession.cliType || 'claude') : 'claude', firstToken);

        // Graph context injection — only when GRAPH_CONTEXT_ENABLED and channel not denied.
        // Local TUI commands (/status, Codex /model, etc.) never start an
        // assistant turn, so retrieval context is wasted and can block a
        // command that should be answered immediately from the pane.
        let graphSystemBlock = '';
        if (!localCommand && process.env.GRAPH_CONTEXT_ENABLED === 'true') {
            try {
                const channelCfg = _getGraphCfg().forChannel(channelId);
                if (channelCfg.enabled) {
                    const threadUrl = _buildSlackArchiveUrl(event.team, channelId, threadTs);
                    const askerEEID = await _getAskerLookup().eeidForSlackUid(userId);
                    graphSystemBlock = await buildContext({
                        enabled: true,
                        seeds: [threadUrl],
                        query: text,
                        askerEEID,
                        depth: channelCfg.depth,
                        budget_tokens: channelCfg.budget_tokens,
                        timeoutMs: channelCfg.timeout_ms,
                    });
                    if (graphSystemBlock) {
                        this.logger.info(`Graph context injected for channel=${channelId} thread=${threadTs} (${graphSystemBlock.length} chars)`);
                    }
                }
            } catch (err) {
                this.logger.warn(`graph context injection failed: ${err.message}`);
                graphSystemBlock = '';
            }
        }

        // Continuation replies inject text straight into the live session and skip
        // _fetchThreadMessages, so attachments on a reply are otherwise dropped. Fetch
        // them here (only for an active session — new sessions already handle files via
        // _fetchThreadMessages, and doing it twice would double-describe).
        if (activeSession && event.files && event.files.length > 0) {
            const fileContents = await this._fetchFileContents(event.files);
            if (fileContents) text += '\n' + fileContents;
        }

        await this._processCommand(channelId, threadTs, text, say, event.ts, null, userId, null, graphSystemBlock, restricted, writeAuthorized, senderName);
    }

    /**
     * Manually promote a pending alert_queue row → 'processing' and fire the
     * investigation immediately. Used when a human types "investigate now" in
     * the alert thread instead of waiting for the queue to drain.
     *
     * Returns true if we handled the message (promoted, posted a notice, or
     * detected an already-running investigation); false means the caller
     * should fall through to normal @mention chat handling.
     */
    async _tryPromoteQueuedAlert({ channelId, threadTs, text, userId, say }) {
        const item = this._queueStmts.getLatestForMessage.get(channelId, threadTs);
        if (!item) return false; // Not an alert thread we tracked.

        if (item.status === 'processing') {
            await say({
                text: ':information_source: Investigation already running for this alert — your follow-up will go to the live session.',
                thread_ts: threadTs,
            });
            return false; // Let _processCommand inject this message into the live session.
        }
        if (item.status !== 'pending') {
            // 'completed' or 'failed' — nothing to promote.
            return false;
        }

        // Atomic claim. result.changes === 0 means _processNextInQueue won the race.
        const result = this._queueStmts.promote.run(Date.now(), item.id);
        if (result.changes === 0) {
            this.logger.info(`Manual promote race: id=${item.id} already dequeued by queue worker`);
            return false;
        }

        // Resolve CLI chain — honor an inline `start <cli>` keyword, else use
        // the configured alert chain.
        let cliChain = this.config.alertCliChain || ['claude'];
        const kwMatch = text.match(CLI_KEYWORD_RE);
        if (kwMatch) {
            const typed = kwMatch[1].toLowerCase();
            cliChain = typed === 'claude' ? ['claude'] : [typed, 'claude'];
        }

        this.logger.info(`Manual promote: id=${item.id} incident=${item.incident_id} channel=${channelId} ts=${threadTs} chain=${cliChain.join('→')} by user=${userId}`);

        // Reactions: hourglass → eyes (matches _processNextInQueue's swap).
        this._removeReaction(channelId, threadTs, 'hourglass_flowing_sand').catch(() => {});
        this._addReaction(channelId, threadTs, 'eyes').catch(() => {});

        await say({
            text: `:zap: Manual override — starting investigation now with \`${cliChain.join(' → ')}\` (bypassing queue).`,
            thread_ts: threadTs,
        });

        // Fire via the normal command flow with the saved alert prompt (NOT
        // the user's "investigate now" text). _processCommand will create the
        // tmux session, set alert_message_ts, and the poller will call
        // _completeQueueItem when the investigation finishes.
        this._processCommand(channelId, threadTs, item.prompt, say, threadTs, item.message_ts, userId, cliChain)
            .catch(err => {
                this.logger.error(`Manual promote: failed to start investigation for id=${item.id}: ${err.message}`);
                this._queueStmts.updateStatus.run('failed', Date.now(), item.id);
            });

        return true;
    }

    // ─── Command Processing ──────────────────────────────────────────

    /**
     * Resolve a Slack user ID to a human display name (real name preferred),
     * cached with a 10-min TTL. Best-effort: returns null on any failure so a
     * lookup hiccup never blocks or breaks a message. Stage-2 will enrich this
     * with agent-mem org context (team/manager); today it's Slack users.info.
     */
    async _resolveSenderName(userId) {
        if (!userId) return null;
        const cached = this._senderNameCache.get(userId);
        if (cached && Date.now() - cached.at < 600000) return cached.name;
        let name = null;
        let department = null;
        // Prefer agent-mem member detection — gives name + org context
        // (department). Best-effort; null on miss or when unconfigured.
        const gc = _getGraphClient();
        if (gc) {
            try {
                const prof = await gc.slackUser(userId);
                if (prof) {
                    name = String(prof.real_name || prof.display_name || '').trim() || null;
                    department = String(prof.department || '').trim() || null;
                }
            } catch (err) {
                this.logger.debug?.(`agent-mem slackUser lookup failed for ${userId}: ${err.message}`);
            }
        }
        // Fall back to Slack users.info for the name when agent-mem has none.
        if (!name) {
            try {
                const info = await this.app.client.users.info({ user: userId });
                const u = info.user || {};
                const p = u.profile || {};
                name = String(p.real_name || u.real_name || p.display_name || u.name || '').trim() || null;
            } catch (err) {
                this.logger.warn(`sender name resolve failed for ${userId}: ${err.message}`);
            }
        }
        // Compose "Name (Department)" when org context is available.
        const display = name ? (department ? `${name} (${department})` : name) : null;
        this._senderNameCache.set(userId, { name: display, at: Date.now() });
        return display;
    }

    /**
     * Build the one-line per-turn sender-identity header prepended to an
     * injected message so the model knows who sent THIS turn. Role is derived
     * from the access tier the bot already computed. Returns '' when there's no
     * user (system/alert flows) so those are left untouched.
     */
    _senderIdentityHeader(userId, senderName, { writeAuthorized = false } = {}) {
        if (!userId) return '';
        const who = senderName || `Slack user ${userId}`;
        let role;
        if (this.accessControl.isOwner(userId)) {
            role = 'the bot owner — full authority over this session\'s identity';
        } else if (writeAuthorized) {
            role = 'a write-authorized teammate (may direct PR approve/merge/push under the bot identity)';
        } else {
            role = 'a Wego teammate';
        }
        return `[Message from: ${who} — ${role}]`;
    }

    async _processCommand(channelId, threadTs, command, say, messageTs, alertMessageTs = null, userId = null, cliHint = null, graphSystemBlock = '', restricted = false, writeAuthorized = false, senderName = null) {
        // Create a say function if one wasn't provided (e.g. alert triggers)
        if (!say) {
            say = async (msg) => {
                await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msg });
            };
        }

        // Normalise the CLI hint to a chain. Callers may pass:
        //   - null / undefined (use @mention keyword or default)
        //   - a single string (back-compat with pre-chain callers)
        //   - an array of CLI names (e.g. ['codex', 'claude']) — first is tried
        //     first; subsequent names are tried only if the previous one hits a
        //     fatal startup error (codex quota exceeded, etc.).
        const normaliseChain = (hint) => {
            if (!hint) return null;
            if (Array.isArray(hint)) {
                const chain = hint.map(s => String(s || '').toLowerCase()).filter(Boolean);
                return chain.length > 0 ? chain : null;
            }
            const single = String(hint).toLowerCase();
            return single ? [single] : null;
        };
        const cliChainHint = normaliseChain(cliHint);
        const sessionKey = `${channelId}-${threadTs}`;
        // Untouched copy of the inbound command, captured before any @mention
        // keyword-stripping mutates `command`. The alert inject-retry path
        // re-enters _processCommand with this so the rebuilt prompt is identical
        // to the first attempt.
        const originalCommand = command;
        let session = this._getSession(sessionKey);
        let threadContext = null; // Will hold formatted thread messages to prepend
        let threadContextLabel = 'Here is the Slack thread discussion for context'; // overridden for a pane-snapshot replay
        // True when the user @mentions the bot with only a `start <cli> from <project>`
        // keyword and no actual task. Used downstream to (a) skip the
        // self-knowledge preamble — which an agentic CLI like Gemini reads as a
        // standing instruction and starts auto-exploring on — and (b) for
        // Gemini specifically, skip the inject entirely so the session sits
        // ready until the user supplies a real task.
        let isTrivialFirstMessage = false;
        // True when the CLI process is brand new for this turn — either a
        // first-ever session or a recreated session that did NOT resume prior
        // CLI state. Used to gate the Slack-mrkdwn formatting guidance so we
        // only teach the rule once per CLI process instead of on every turn.
        // Live sessions and resumed sessions stay false (the CLI already saw
        // the guidance on its first turn).
        let isFreshCliBoot = false;
        // Tracks the still-untried CLIs starting at the currently-running one.
        // Set after _startCliWithFallback succeeds; consulted on inject failure
        // so a paste-rejecting CLI can hand off to the next one in the chain.
        // Stays null on existing-live-session injects (no fallback there —
        // mid-conversation CLI swap would lose context).
        let injectChain = null;

        // Guard: slash commands on a session that EXISTED but whose tmux died.
        // A `/<skill>` typed into a thread whose session has expired can't be
        // injected anywhere meaningful, so we tell the user to send a plain
        // message (which recreates the session) and re-issue the command.
        //
        // A brand-new thread (no session row at all) is NOT rejected: a
        // `/<skill>` there boots a fresh session and is injected as its first
        // prompt — the same thing the alert flow already does with its
        // auto-generated `/<ALERT_SKILL>` (those carry a cliChainHint). The
        // brand-new-conversation branch below handles the boot + inject; the
        // command-assembly step keeps the slash command at the very start of
        // the injected text so the CLI parses it as a command.
        const isLiveSession = session && this._isTmuxSessionAlive(session.sessionName);
        // Match exit slash-commands on the FIRST token so natural-chat
        // trailers ("/exit for now", "/quit thanks") still close cleanly.
        // Codex owns `/stop` as "stop background terminals", so only legacy
        // Claude/Gemini sessions treat `/stop` as a bot-level close synonym.
        const firstTokenForExit = command.split(/\s/)[0];
        const sessionCliTypeForExit = session ? (session.cliType || 'claude') : 'claude';
        const EXIT_COMMANDS = new Set(['/exit', '/quit']);
        if (sessionCliTypeForExit !== 'codex') EXIT_COMMANDS.add('/stop');
        const isExitCommand = EXIT_COMMANDS.has(firstTokenForExit);
        if (command.startsWith('/') && session && !isLiveSession && !isExitCommand && !cliChainHint) {
            const cmd = command.split(/\s/)[0];
            await say({ text: `Session expired. \`${cmd}\` requires an active session — send a message first to start a new one, then use \`${cmd}\`.`, thread_ts: threadTs });
            return;
        }
        // /exit on a thread that has no session at all — nothing to close.
        // Without this, the brand-new-conversation branch would spin up a fresh
        // tmux session just to inject `/exit` and tear it straight back down.
        if (isExitCommand && !session) {
            await say({ text: 'No active session in this thread.', thread_ts: threadTs });
            return;
        }

        // /exit — clean up the session regardless of tmux state. Lifted above
        // the live/dead branching so a /exit on a dead-tmux row doesn't trigger
        // a fresh tmux spin-up just to immediately kill it (which also leaves
        // the alert queue slot stuck if the recreate path posts a "Restarting…"
        // message and the user can't tell whether the incident actually closed).
        if (isExitCommand && session) {
            const pollKey = session.sessionName;
            if (this.pollers.has(pollKey)) {
                clearInterval(this.pollers.get(pollKey).interval);
                this.pollers.delete(pollKey);
            }
            if (this._isTmuxSessionAlive(session.sessionName)) {
                try {
                    // Inject the canonical `/exit` regardless of which synonym
                    // the user typed (or any trailing words) so the CLI sees the
                    // command it understands, not "/quit thanks".
                    await this._injectCommand(session.sessionName, '/exit', session.cliType);
                } catch {
                    // Expected — /exit kills the session before Enter-retry finishes.
                }
            }
            this._deleteSession(sessionKey);
            this._clearSessionTimeout(sessionKey);
            this._clearPaneSnapshot(sessionKey); // intentional close — don't replay on a future thread reuse
            if (session.alertMessageTs) {
                try {
                    await this._removeReaction(channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(channelId, session.alertMessageTs, 'white_check_mark');
                } catch (err) {
                    this.logger.warn(`Failed to swap alert reactions on /exit (channel=${channelId} ts=${session.alertMessageTs}): ${err.message}`);
                }
                // Free the queue slot so the next pending alert can start.
                this._completeQueueItem(channelId, session.alertMessageTs);
            }
            try {
                await this.app.client.reactions.add({
                    channel: channelId,
                    timestamp: messageTs,
                    name: 'white_check_mark',
                });
            } catch (err) {
                this.logger.warn(`Failed to ack /exit message (ts=${messageTs}): ${err.message}`);
            }
            return;
        }

        // ─── Built-in local TUI commands ───────────────────────────────────
        // These never reach the generic inject path — no assistant turn
        // starts and no Stop hook fires for them, so the bot must drive and
        // answer them itself. Matched on the first token; turn-starting slash
        // commands and skills stay on the generic path so CLI hooks post the
        // real assistant reply.
        const firstToken = command.split(/\s/)[0];
        const interceptCli = session ? (session.cliType || 'claude') : 'claude';
        const localCommand = _adapterLocalSlashCommand(interceptCli, firstToken);
        if (localCommand) {
            // Claude /model needs its dedicated owner-gated switch handler.
            // Other CLIs classify /model through adapter.localSlashCommands;
            // Codex treats it as a panel so we can scrape and close the picker.
            if (localCommand.type === 'model') {
                await this._handleModelCommand({
                    sessionKey, channelId, threadTs, messageTs, command,
                    session, isLiveSession, restricted,
                });
                return;
            }
            if (localCommand.type === 'blocked') {
                await say({ text: `\`${firstToken}\` isn't available from Slack — ${localCommand.reason}.`, thread_ts: threadTs });
                return;
            }
            await this._handleCliLocalCommand({
                sessionKey, channelId, threadTs, command, firstToken,
                session, isLiveSession, restricted,
                kind: localCommand.type,
            });
            return;
        }

        try {
            if (session && this._isTmuxSessionAlive(session.sessionName)) {
                // Tmux alive — Claude already has full context, just inject the raw command
                this._touchSession(sessionKey);
                if (userId) this._updateLastUserId(sessionKey, userId);
                this._clearSessionTimeout(sessionKey); // User sent a message — bot is now processing, don't timeout while user waits
                // No thread context needed — Claude is already in the conversation
                this.logger.info(`Existing live session ${session.sessionName}, injecting command directly`);
            } else if (session && !this._isTmuxSessionAlive(session.sessionName)) {
                // Session in DB but tmux died — recreate using the ORIGINAL
                // CLI and ORIGINAL folder. Chain resolution:
                //   1. Caller-supplied chain hint (alerts pass ALERT_CLI —
                //      that's system policy, not a user override).
                //   2. Saved CLI with Claude appended as last-resort fallback.
                // User-typed "start <cli>" / "from <project>" hints are
                // deliberately ignored on resume so the session always comes
                // back with the same provider and folder it was launched with.
                // To switch CLI or folder, the user must /exit first to clear
                // the session row.
                const resumeSavedCli = session.cliType || 'claude';
                let resumeChain;
                if (cliChainHint && cliChainHint.length > 0) {
                    resumeChain = cliChainHint;
                } else {
                    resumeChain = resumeSavedCli === 'claude' ? ['claude'] : [resumeSavedCli, 'claude'];
                }
                // Strip the resume preamble + any stale CLI/project hints from
                // the user's text so the CLI sees a clean prompt (e.g.
                // "resume claude from agent-mem do X" → "do X").
                command = command
                    .replace(RESUME_PREFIX_STRIP_RE, '')
                    .replace(CLI_KEYWORD_RE, '')
                    .replace(START_FROM_STRIP_RE, '')
                    .replace(PROJECT_STRIP_RE, '')
                    .trim();
                // If we have a saved CLI session id AND the chain leads with
                // the same CLI, ask the launcher to use the adapter's resume
                // command. Different first CLI → resume id wouldn't apply.
                let resumeIdForFirst = (resumeChain[0] === resumeSavedCli && session.claudeSessionId)
                    ? session.claudeSessionId : null;
                // Only promise "with prior context" if the adapter actually
                // supports resume. Gemini's buildResumeCommand returns null →
                // the launcher silently falls back to a fresh launch; without
                // this gate the user sees "Resuming with prior context :rocket:"
                // while the new process boots with empty history.
                if (resumeIdForFirst) {
                    const firstAdapter = getCliAdapter(resumeChain[0]);
                    const wouldResume = typeof firstAdapter.buildResumeCommand === 'function'
                        && firstAdapter.buildResumeCommand(resumeIdForFirst);
                    if (!wouldResume) resumeIdForFirst = null;
                }
                this.logger.warn(`Tmux session ${session.sessionName} is dead, recreating in ${session.repoPath} (chain=${resumeChain.join('→')}${resumeIdForFirst ? `, resume=${resumeIdForFirst}` : ''})...`);
                await say({
                    text: resumeIdForFirst
                        ? `Resuming \`${resumeSavedCli}\` session in \`${session.repoPath}\` with prior context... :rocket:`
                        : `Restarting session in \`${session.repoPath}\` (CLI chain: ${resumeChain.join(' → ')})... :rocket:`,
                    thread_ts: threadTs,
                });

                const resumeResult = await this._startCliWithFallback({
                    sessionName: session.sessionName,
                    repoPath: session.repoPath,
                    sessionKey,
                    cliChain: resumeChain,
                    resumeIdForFirst,
                    onFallback: async ({ failedCli, nextCli, reason }) => {
                        const body = nextCli
                            ? `:warning: \`${failedCli}\` failed to start (${reason}) — falling back to \`${nextCli}\`.`
                            : `:x: \`${failedCli}\` failed to start (${reason}) and no fallback CLI is configured.`;
                        await say({ text: body, thread_ts: threadTs });
                    },
                });
                if (!resumeResult.ok) {
                    await say({ text: `Failed to resume session — tried ${resumeChain.join(', ')}. Is tmux installed?`, thread_ts: threadTs });
                    this._deleteSession(sessionKey);
                    return;
                }
                // Persist the actually-running CLI on the row so subsequent
                // polling / injection uses the correct adapter.
                if (resumeResult.cliType !== resumeSavedCli) {
                    try {
                        this.db.prepare('UPDATE sessions SET cli_type = ?, updated_at = ? WHERE session_key = ?')
                            .run(resumeResult.cliType, Date.now(), sessionKey);
                        session.cliType = resumeResult.cliType;
                    } catch (err) {
                        this.logger.error(`Failed to update cli_type on resume: ${err.message}`);
                    }
                }
                // Surface the remaining chain so a paste-rejection on the
                // first inject can fall back further (e.g. resumed Codex
                // accepted readiness but won't take input → switch to Claude).
                injectChain = resumeResult.remainingChain || [resumeResult.cliType];
                // Re-stash the runtime-fallback context on the recreated
                // session. The brand-new-session path does this below, but a
                // requeued alert (attempt 2+) lands here instead — without the
                // stash the poller's LAYER 6 check (`session.alertPrompt`)
                // fails and the still-untried CLIs in the chain are never
                // reached (incident Q2ORYNHDWLISDZ, 2026-06-12).
                if (session.alertMessageTs) {
                    session.injectChain = injectChain;
                    session.alertPrompt = command;
                }
                this._touchSession(sessionKey);
                if (resumeResult.resumed) {
                    // CLI restored its own conversation history — keep the saved
                    // session id and skip the thread-context replay block (the
                    // CLI already remembers everything).
                    this.logger.info(`Resumed ${resumeResult.cliType} session — skipping thread-context replay`);
                } else {
                    // Fresh CLI process: the resumed session id (if any)
                    // belongs to the previous, now-dead process. Clear it so
                    // the next SessionStart hook can register the new id
                    // without COALESCE preserving the stale value (which
                    // would make the Stop hook treat the new session as a
                    // subagent).
                    this._stmts.updateClaudeSessionId.run(null, Date.now(), sessionKey);
                    isFreshCliBoot = true;

                    // Prefer the actual tmux pane scrollback captured while the
                    // previous process was alive — it holds the CLI's own
                    // reasoning and tool work, which the Slack thread (only the
                    // posted replies) can't. Fall back to the Slack-thread
                    // replay when no snapshot exists (e.g. very first recreate
                    // before any turn completed, or snapshot cleared on /exit).
                    const paneSnapshot = this._readPaneSnapshot(sessionKey);
                    if (paneSnapshot) {
                        threadContext = paneSnapshot;
                        threadContextLabel = 'Your previous terminal session ended; here is its recent transcript (your earlier work) for context';
                        this.logger.info(`Pane snapshot replay (recreated session): ${paneSnapshot.length} chars`);
                    } else {
                        // Fetch thread context — summarize with Gemini if long.
                        const allMessages = await this._fetchThreadMessages(channelId, threadTs);
                        if (allMessages.length > 10) {
                            threadContext = await this._summarizeThreadContext(allMessages);
                            this.logger.info(`Summarized thread context (recreated session): ${allMessages.length} messages`);
                        } else if (allMessages.length > 0) {
                            threadContext = await this._formatThreadContext(allMessages);
                            this.logger.info(`Full thread context (recreated session): ${allMessages.length} messages`);
                        }
                    }
                }
                if (userId) this._updateLastUserId(sessionKey, userId);
            } else {
                // Brand new conversation
                const sessionName = this._generateSessionName(channelId, threadTs);

                // Resolve CLI chain. Priority:
                //   1. Caller-supplied chain (alerts / delay alerts pass the
                //      configured ALERT_CLI / DELAY_ALERT_CLI chain).
                //   2. Per-message keyword in @mention chat ("start codex
                //      from ..."). Keyword starts the chain; Claude is
                //      appended as the last-resort fallback so users don't
                //      get stuck on a broken Codex.
                //   3. Default single-element ['claude'] chain.
                let cliChain;
                if (cliChainHint && cliChainHint.length > 0) {
                    cliChain = cliChainHint;
                } else {
                    const cliKeywordMatch = command.match(CLI_KEYWORD_RE);
                    if (cliKeywordMatch) {
                        const typed = cliKeywordMatch[1].toLowerCase();
                        cliChain = typed === 'claude' ? ['claude'] : [typed, 'claude'];
                    } else {
                        cliChain = ['claude'];
                    }
                }
                const cliType = cliChain[0];

                // Resolve repo path — check for project name patterns.
                // Supported:  "start [cli] from root" → uses SLACK_REPO_ROOT directly
                //             "project XXX from root", "start [cli] from XXX project"
                //             "start [cli] from XXX", "start [cli] in XXX project"
                // The `[cli]` slot accepts any registered adapter name (see CLI_NAMES_ALT).
                let repoPath = this.config.repoPath || process.cwd();
                const rootMatch = command.match(ROOT_COMMAND_RE);
                const projectMatch = !rootMatch && (
                    command.match(PROJECT_COMMAND_RE) || command.match(START_FROM_RE)
                );
                if (rootMatch) {
                    if (this.config.repoRoot) {
                        repoPath = this.config.repoRoot;
                        command = command.replace(ROOT_COMMAND_RE, '').trim();
                        this.logger.info(`Using repo root: ${repoPath}`);
                    } else {
                        await say({ text: '`SLACK_REPO_ROOT` is not configured. Set it in `.env`.', thread_ts: threadTs });
                        return;
                    }
                } else if (projectMatch && this.config.repoRoot) {
                    const projectName = projectMatch[1];
                    const candidatePath = path.join(this.config.repoRoot, projectName);
                    if (fs.existsSync(candidatePath)) {
                        repoPath = candidatePath;
                        // Strip the project resolution part so the CLI gets a clean prompt
                        command = command
                            .replace(PROJECT_STRIP_RE, '')
                            .replace(START_FROM_STRIP_RE, '')
                            .trim();
                        this.logger.info(`Resolved project "${projectName}" to ${repoPath}`);
                    } else {
                        await say({ text: `Project folder not found: \`${candidatePath}\``, thread_ts: threadTs });
                        return;
                    }
                } else if (projectMatch && !this.config.repoRoot) {
                    await say({ text: '`SLACK_REPO_ROOT` is not configured. Set it in `.env` to use project switching.', thread_ts: threadTs });
                    return;
                }

                // If no project detected from command, check if this is a thread continuation
                // and use Gemini to detect the project from thread history
                let prefetchedMessages = null;
                if (!rootMatch && !projectMatch && this.config.repoRoot) {
                    prefetchedMessages = await this._fetchThreadMessages(channelId, threadTs);
                    if (prefetchedMessages.length > 1) {
                        const detectedPath = await this._detectProjectFromThread(prefetchedMessages);
                        if (detectedPath && fs.existsSync(detectedPath)) {
                            repoPath = detectedPath;
                            this.logger.info(`Gemini detected project path: ${repoPath}`);
                        }
                    }
                }

                // Strip a leading `start <cli>` keyword so a bare "start gemini"
                // (no `from <project>` clause, no task body) collapses to an
                // empty command and is treated as a trivial first message —
                // same as "start gemini from payments". Without this the keyword
                // survives as the literal prompt and, with the ask-user preamble
                // prepended, an agentic CLI reads it as a task and wanders off
                // into its own TUI menu that never reaches Slack (incident
                // 1781766824, 2026-06-18). The resume path already does this strip.
                command = command.replace(CLI_KEYWORD_RE, '').trim();

                // If command was fully consumed by project pattern, default to "hi"
                if (!command) {
                    isTrivialFirstMessage = true;
                    command = 'hi';
                }

                const startResult = await this._startCliWithFallback({
                    sessionName,
                    repoPath,
                    sessionKey,
                    cliChain,
                    onFallback: async ({ failedCli, nextCli, reason }) => {
                        const body = nextCli
                            ? `:warning: \`${failedCli}\` failed to start (${reason}) — falling back to \`${nextCli}\`.`
                            : `:x: \`${failedCli}\` failed to start (${reason}) and no fallback CLI is configured.`;
                        await say({ text: body, thread_ts: threadTs });
                    },
                });
                if (!startResult.ok) {
                    if (alertMessageTs) {
                        await this._removeReaction(channelId, alertMessageTs, 'eyes');
                        await this._addReaction(channelId, alertMessageTs, 'x');
                    } else {
                        await say({ text: `Failed to start any CLI. Tried: ${cliChain.join(', ')}.`, thread_ts: threadTs });
                    }
                    return;
                }

                // Resolved CLI — may differ from the first preference if we fell back.
                const resolvedCliType = startResult.cliType;
                // Surface the remaining chain so the inject step can fall back
                // further if the resolved CLI accepts readiness but rejects paste.
                injectChain = startResult.remainingChain || [resolvedCliType];

                session = {
                    sessionName,
                    channelId,
                    threadTs,
                    repoPath,
                    createdAt: Date.now(),
                    alertMessageTs: alertMessageTs || null,
                    cliType: resolvedCliType
                };
                this._saveSession(session);
                // Alert sessions: stash the still-untried chain + the bare
                // user prompt on the in-memory session so the response poller
                // can run a runtime-fallback path when the resolved CLI hangs
                // mid-investigation (e.g. Gemini API geo-blocked even though
                // its TUI rendered the ready placeholder). Not persisted to
                // DB — restart-safe enough via the queue's existing requeue.
                if (alertMessageTs) {
                    session.injectChain = injectChain;
                    session.alertPrompt = command;
                }
                isFreshCliBoot = true;
                if (userId) this._updateLastUserId(`${channelId}-${threadTs}`, userId);

                // Fetch thread context — summarize with Gemini if this is a continuation
                const allMessages = prefetchedMessages || await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 10) {
                    threadContext = await this._summarizeThreadContext(allMessages);
                    this.logger.info(`Summarized thread context (new session): ${allMessages.length} messages`);
                } else if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (new session): ${allMessages.length} messages`);
                }

                this.logger.info(`New session created: ${sessionName} for channel ${channelId}`);
                // Don't start timeout yet — bot is processing the first command. Timeout starts when bot responds.
            }


            // A bare "start <cli> from <project>" with no task body leaves an
            // empty prompt that we'd otherwise inject as a synthetic "hi". That
            // is pure downside for every CLI:
            //   - Gemini (under --yolo + Serena onboarding) reads "hi" + the
            //     self-knowledge preamble as "go set up the workspace" and
            //     starts editing files.
            //   - Claude/Codex paste a 2-char "hi" that carries no intent, and
            //     when the host is busy the paste-verification race surfaces a
            //     scary "Paste failed after 5 attempts" even though the session
            //     is healthy (incident 1781679376, 2026-06-17).
            // Skip the inject entirely — the session is already saved, so the
            // next @mention in this thread lands on the live session and
            // injects the real task.
            if (isTrivialFirstMessage) {
                this.logger.info(`Session ${session.sessionName} (cli=${session.cliType}) ready; skipping inject for trivial first message`);
                await say({
                    text: `Session ready in \`${session.repoPath}\`. What would you like me to work on?`,
                    thread_ts: threadTs,
                });
                this._startSessionTimeout(sessionKey);
                return;
            }

            // Build the full command with thread context if available.
            // Preamble points Claude at the bot's own source repo so meta-questions
            // ("why was X tagged?", "how does the queue work?") can be answered
            // accurately without requiring us to enumerate every behavior in a static doc.
            // Skipped on a trivial first message ("hi") because the preamble's
            // "read files at <path>" instruction otherwise reads as a task by
            // itself when no real user request follows.
            const BOT_SELF_KNOWLEDGE_PREAMBLE = `You are responding inside a Slack thread for the EnzoBot Slack bot.\nIf the user asks about the bot's own behavior (notifications, tagging, queue, alerts, etc.),\nthe bot's source lives at /var/go/src/github.com/Claude-Code-Remote — read files there to answer accurately.\n\n`;
            // A skill turn is either a slash form (`/xxxx …`) or a natural-language
            // request to run one (`execute /xxxx skill for me`, `run the deploy
            // skill with argument …`). The optional leading `/` and trailing tail
            // ("for me", "with argument …", nothing) are all accepted. Computed
            // here (ahead of the context-wrapping block) because a slash command
            // must stay at the very FIRST character of the injected text or the
            // CLI won't recognise it as a command — so context is attached
            // differently for skill turns vs plain chat.
            const isSkillInvocation = command.startsWith('/')
                || /^\s*(?:execute|run)\s+(?:the\s+)?\/?\S+\s+skill\b/i.test(command);
            let fullCommand = command;
            if (threadContext && !isTrivialFirstMessage) {
                if (command.startsWith('/')) {
                    // Slash command: keep `/cmd …` first so the CLI parses it,
                    // then append the thread context below — it lands in the
                    // skill's argument string ($ARGUMENTS) instead of shoving a
                    // preamble in front of the command (which would stop it being
                    // a command at all). No self-knowledge preamble here: a skill
                    // turn follows SKILL.md, not the meta-question preamble.
                    fullCommand = `${command}\n\n${threadContextLabel}:\n\n---\n${threadContext}\n---`;
                } else {
                    fullCommand = `${BOT_SELF_KNOWLEDGE_PREAMBLE}${threadContextLabel}:\n\n---\n${threadContext}\n---\n\nMy request: ${command}`;
                }
            }

            // Slack mrkdwn reminder — sent ONCE on the first turn of a fresh
            // CLI process. Live-session injects and resumed processes already
            // saw the rule in their first turn, so repeating it just pollutes
            // context. Skill prompts (`/<skill>` or the natural-language
            // `execute <skill> skill with argument …` form) carry their own
            // formatting rules via SKILL.md, so skip the guidance for those —
            // otherwise we'd double up. Trade-off vs the previous every-turn
            // approach: Gemini may drift back to GitHub `**bold**` later in a
            // long session since it doesn't get re-reminded — acceptable to
            // avoid the noise on Claude/Codex.
            if (!isSkillInvocation && !isTrivialFirstMessage && isFreshCliBoot) {
                const chatAdapter = getCliAdapter(session.cliType);
                const guidance = typeof chatAdapter.chatFormattingGuidance === 'function'
                    ? chatAdapter.chatFormattingGuidance() : '';
                if (guidance) {
                    fullCommand = `${guidance}${fullCommand}`;
                }
            }

            // MCP slack-ask: keep Claude pointed at the ask_user MCP tool so it
            // never falls back to the built-in AskUserQuestion picker, which
            // renders in a TUI invisible to the Slack user (a question asked
            // there silently stalls the session — incident 2026-06-15). The
            // full schema is taught ONCE on the fresh-boot turn; every later
            // non-skill turn gets a cheap one-line reminder. The repeat matters
            // because the boot-turn teach is defeated whenever the boot turn is
            // a trivial `start <cli> from <project>` greeting — the model then
            // reaches its first real question turn never having seen the nudge.
            // Gated by MCP_ENABLED so disabled installs stay clean; skipped for
            // skill turns (SKILL.md is authoritative there).
            if (!isSkillInvocation && !isTrivialFirstMessage) {
                const chatAdapter = getCliAdapter(session.cliType);
                if (
                    process.env.MCP_ENABLED === 'true'
                    && chatAdapter.supportsAskUser
                ) {
                    const askText = isFreshCliBoot
                        && typeof chatAdapter.askUserGuidance === 'function'
                        ? chatAdapter.askUserGuidance()
                        : (typeof chatAdapter.askUserReminder === 'function'
                            ? chatAdapter.askUserReminder()
                            : '');
                    if (askText) {
                        fullCommand = `${askText}${fullCommand}`;
                    }
                }
            }

            // Prepend graph system block when provided. Only on fresh CLI boots
            // to avoid re-injecting graph context on every turn of a live session
            // (the graph context is already in the model's conversation history).
            if (graphSystemBlock && isFreshCliBoot) {
                fullCommand = `${graphSystemBlock}\n\n---\n\n${fullCommand}`;
                this.logger.info(`Graph system block prepended (${graphSystemBlock.length} chars) for session ${session.sessionName}`);
            }

            // Prepend the credential-honesty rule on fresh CLI boots so
            // investigations verify each credential before reporting it as
            // down, instead of guessing/conflating (see the constant's note).
            if (isFreshCliBoot) {
                fullCommand = `${CREDENTIAL_HONESTY_PREAMBLE}\n\n---\n\n${fullCommand}`;
                this.logger.info(`Credential-honesty preamble prepended for session ${session.sessionName}`);
            }

            // Restricted (team, non-owner) users: prepend the access boundary
            // that forbids disclosing personal / server info. Re-asserted EVERY
            // turn (not just fresh boot) so it holds across a live session and
            // even if a different, non-owner user replies later in the thread.
            // Slash commands must stay first-char, so append there instead.
            if (restricted) {
                let boundary = this.accessControl.restrictionPreamble();
                // Write-authorized teammate (member of SLACK_WRITE_SUBTEAMS):
                // grant repo write actions on top of the disclosure boundary.
                // Stays coupled to the every-turn restriction block on purpose —
                // the boundary re-asserts "you are NOT the owner" each turn, so
                // the grant must ride the SAME turn the write is requested on
                // (rarely the boot turn), or the model sees only the refusal.
                if (writeAuthorized) {
                    boundary = `${boundary}\n\n${this.accessControl.writeGrantPreamble()}`;
                }
                fullCommand = command.startsWith('/')
                    ? `${fullCommand}\n\n${boundary}`
                    : `${boundary}\n\n---\n\n${fullCommand}`;
                this.logger.info(`Access boundary injected (restricted user${writeAuthorized ? ', write-authorized' : ''}) for session ${session.sessionName}`);
            } else if (isFreshCliBoot && this.accessControl.enforced && this.accessControl.isOwner(userId)) {
                // Owner turn: assert full authority so the model won't refuse
                // owner-authorized writes (PR approvals, pushes) as third-party.
                // Fresh-boot ONLY — the statement persists in the session's
                // conversation history, so re-asserting it every turn is just
                // redundant noise (same reasoning as the graph-context and
                // credential-honesty preambles above). Owner turns never carry
                // the restriction block, so nothing later in the thread
                // contradicts the boot-turn grant. A live session started before
                // this shipped won't retroactively get it — /exit + resume to
                // pick it up. Only when access is enforced (open installs have no
                // restriction dynamic to counteract).
                const ownerPre = this.accessControl.ownerPreamble();
                fullCommand = command.startsWith('/')
                    ? `${fullCommand}\n\n${ownerPre}`
                    : `${ownerPre}\n\n---\n\n${fullCommand}`;
                this.logger.info(`Owner-authority preamble injected (fresh boot) for session ${session.sessionName}`);
            }

            // Per-turn sender identity header. The bot injects only the raw
            // message text, so the model otherwise can't tell who sent THIS turn
            // (it saw every turn as one anonymous "user" — why it once refused
            // the owner's own approve request). Unlike the authority preamble
            // (fresh-boot only), this is legitimately per-turn: the speaker can
            // change with every message in a thread. Kept to one short line —
            // it's message metadata, not a standing instruction.
            const idHeader = this._senderIdentityHeader(userId, senderName, { writeAuthorized });
            if (idHeader) {
                fullCommand = command.startsWith('/')
                    ? `${fullCommand}\n\n${idHeader}`
                    : `${idHeader}\n\n---\n\n${fullCommand}`;
            }

            // Inject the command into the tmux session.
            //
            // If injection fails (e.g. the CLI accepted readiness but rejects
            // the paste — Codex's slow-startup race) and we have remaining
            // CLIs in the chain from the start step, kill tmux, restart with
            // the next CLI, and retry the inject. Skipped for existing live
            // sessions (injectChain stays null there) so a mid-conversation
            // failure doesn't silently lose context by switching CLIs.
            let injected = false;
            let lastInjectError = null;
            while (!injected) {
                try {
                    // Clear any stale "hook posted" marker from a previous turn
                    // before this inject runs — otherwise _verifyTurnProgress
                    // would short-circuit on the previous marker and skip
                    // verification of THIS inject.
                    try { fs.unlinkSync(`/tmp/cli-hook-post-${sessionKey}`); } catch { /* no prior marker */ }
                    try { fs.unlinkSync(`/tmp/cli-hook-prompt-${sessionKey}`); } catch { /* no prior marker */ }
                    const injectStartedAt = Date.now();
                    const baseline = await this._injectCommand(session.sessionName, fullCommand, session.cliType);
                    // Guard against silent rejection (Codex at usage limit, Enter
                    // dropped by late banner redraw, etc.). _injectCommand can
                    // succeed because paste landed, but the CLI may never start
                    // a turn — without this check the poller would sit idle for
                    // 30 min and no fallback would fire.
                    await this._verifyTurnProgress(session.sessionName, session.cliType, baseline, sessionKey, injectStartedAt);
                    injected = true;
                } catch (injectError) {
                    lastInjectError = injectError;
                    this.logger.error(`Injection failed for ${session.sessionName} (cli=${session.cliType}): ${injectError.message}`);

                    const nextCli = injectChain && injectChain.length > 1 ? injectChain[1] : null;
                    if (!nextCli) break;

                    const failedCli = session.cliType;
                    try { execSync(`tmux kill-session -t ${session.sessionName} 2>/dev/null`); } catch { /* already gone */ }

                    await say({
                        text: `:repeat: \`${failedCli}\` couldn't accept the prompt (${injectError.message}) — retrying with \`${nextCli}\`...`,
                        thread_ts: threadTs,
                    });

                    const retryChain = injectChain.slice(1);
                    const retryResult = await this._startCliWithFallback({
                        sessionName: session.sessionName,
                        repoPath: session.repoPath,
                        sessionKey,
                        cliChain: retryChain,
                        onFallback: async ({ failedCli: fc, nextCli: nc, reason }) => {
                            const body = nc
                                ? `:warning: \`${fc}\` failed to start (${reason}) — falling back to \`${nc}\`.`
                                : `:x: \`${fc}\` failed to start (${reason}) and no fallback CLI is configured.`;
                            await say({ text: body, thread_ts: threadTs });
                        },
                    });

                    if (!retryResult.ok) {
                        lastInjectError = new Error(`Fallback CLI \`${nextCli}\` failed to start: ${retryResult.fatalError || 'launch error'}`);
                        break;
                    }

                    // Update DB + in-memory session to the newly-running CLI.
                    try {
                        this.db.prepare('UPDATE sessions SET cli_type = ?, updated_at = ? WHERE session_key = ?')
                            .run(retryResult.cliType, Date.now(), sessionKey);
                    } catch (err) {
                        this.logger.error(`Failed to update cli_type after inject fallback: ${err.message}`);
                    }
                    session.cliType = retryResult.cliType;
                    injectChain = retryResult.remainingChain || [retryResult.cliType];
                    // Keep session.injectChain in sync with the latest chain so
                    // the response poller's runtime-fallback path sees the
                    // correct "still-untried" CLIs after this inject recovery.
                    if (session.alertMessageTs) {
                        session.injectChain = injectChain;
                    }
                    // Loop continues with the new CLI.
                }
            }

            if (!injected) {
                const message = lastInjectError ? lastInjectError.message : 'unknown error';
                // Alert sessions: a paste-never-landed failure on the last CLI in
                // the chain is the startup-race signature (host CPU starvation),
                // not a genuine task failure. PagerDuty alerts get the alert_queue
                // requeue; delay alerts bypass the queue, so without this they're
                // a silent drop. Retry the whole investigation from a fresh tmux
                // run before giving up. Returns true if a retry was scheduled.
                if (session.alertMessageTs) {
                    const scheduled = this._retryAlertInvestigation({
                        channelId, threadTs, command: originalCommand, messageTs,
                        alertMessageTs, userId, cliChainHint, reason: message,
                    });
                    if (scheduled) return;
                    // Budget exhausted — flip 👀 → ❌ and fall through to give-up.
                    await this._removeReaction(channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(channelId, session.alertMessageTs, 'x');
                }
                await say({ text: `:warning: ${message}. Try sending your message again.`, thread_ts: threadTs });
                this._startSessionTimeout(sessionKey);
                return;
            }
            // Injection succeeded — clear any inject-retry counter for this alert.
            this._alertInjectRetries.delete(sessionKey);
            this.logger.info(`Command injected into ${session.sessionName}: ${fullCommand.substring(0, 120)}`);

            // Show Slack's native assistant status under the app name while the
            // CLI works (OpenClaw's "Gathering information…" effect). The
            // animation is driven by loading_messages — Slack rotates through
            // them. Regular @mention replies are posted by cli-hook-notify.js
            // (the Stop hook), and Slack auto-clears the status the moment that
            // message lands; the no-post timeout/teardown paths clear it too.
            this._setThreadStatus(session.channelId, threadTs, 'Thinking…', [
                'Thinking…', 'Working on it…', 'Reading the code…',
                'Crunching…', 'Putting it together…', 'Almost there…',
            ]);

            // Commands like /compact don't produce a standard response — just confirm
            // Skip confirmation for alert sessions (eyes reaction is sufficient).
            // Echo the command verbatim: not every `/word` is a skill — keywords
            // (/ultrathink), built-ins (/compact, /clear) and unknown commands also
            // start with `/`. The old "Execute skill X with argument Y" framing
            // mislabeled all of them (that prose form is only how alert prompts
            // invoke skills), which confused users; the raw command is what was
            // actually injected, so show that.
            if (command.startsWith('/') && !session.alertMessageTs) {
                await say({ text: `Sent \`${command}\` to the ${session.cliType || 'claude'} session.`, thread_ts: threadTs });
            }

            // Regular sessions: response posting is handled by cli-hook-notify.js (Stop / Codex notify)
            // which reads the transcript for clean markdown output.
            // Alert sessions: start the poller to swap reactions (👀→✅) when Claude finishes.
            // The hook handles final posting — no stall detection needed.
            if (session.alertMessageTs) {
                this.logger.info(`Starting alert poller for ${session.sessionName} (alertMessageTs=${session.alertMessageTs})`);
                this._pollForResponse(session, say, sessionKey);
            } else {
                // Regular @mention chat: the reply is posted by cli-hook-notify.js
                // when the CLI fires its Stop hook. Arm a watchdog so a stuck/long
                // sub-agent — or a teardown before the hook fires — surfaces a
                // status to the thread instead of leaving it silent.
                this._startInflightWatchdog(sessionKey);
            }

        } catch (error) {
            this.logger.error('Error processing command:', error.message);
            await say({ text: `Error: ${error.message}`, thread_ts: threadTs });
        }
    }

    // ─── Tmux Management ─────────────────────────────────────────────

    _generateSessionName(channelId, threadTs) {
        const suffix = threadTs.replace('.', '').slice(-12);
        return `slack-${channelId.slice(-4)}-${suffix}`;
    }

    _ensureTmuxServer() {
        try {
            execSync('tmux list-sessions 2>/dev/null', { stdio: 'ignore' });
        } catch {
            // No server running — start one with a detached keepalive session
            try {
                execSync('tmux new-session -d -s _keepalive', { stdio: 'ignore' });
                this.logger.info('Started tmux server (no existing server found)');
            } catch (e) {
                this.logger.warn(`Failed to start tmux server: ${e.message}`);
            }
        }
    }

    async _createTmuxSession(sessionName, repoPath, cliCmd, sessionKey = null, cliType = 'claude', extraEnv = {}) {
        const result = await this._createTmuxSessionDetailed(sessionName, repoPath, cliCmd, sessionKey, cliType, extraEnv);
        return result.ok;
    }

    // Detailed tmux creation with fatal-error detection. Returns:
    //   { ok: true,  fatalError: null }    — session ready (or timed out, proceeded anyway)
    //   { ok: false, fatalError: string }  — adapter's fatalErrorPatterns matched
    //                                        (e.g. Codex quota exceeded). Tmux
    //                                        session is killed so caller can retry
    //                                        with the next CLI in the chain.
    //   { ok: false, fatalError: null }    — tmux itself failed to launch.
    //
    // Wraps the boot with an input-liveness gate. A CLI can paint a complete,
    // idle-looking TUI and still never read its terminal: on 2026-08-04 three
    // fresh Claude Code 2.1.221 sessions came up with banner, footer, `⏵⏵
    // bypass permissions on` and an empty `❯` box, `session:0m`, ~1.7% CPU —
    // and ignored every keystroke for good, literal `send-keys` included. The
    // readiness probe only reads the pane, so it passes, and then every paste
    // is thrown into a process that will never see it. The user gets "Paste
    // failed after 5 attempts" and has to attach to tmux for nothing, because
    // the box really is empty. So prove the TUI echoes a keystroke before
    // handing the session over, and give a wedged boot one clean relaunch.
    async _createTmuxSessionDetailed(sessionName, repoPath, cliCmd, sessionKey = null, cliType = 'claude', extraEnv = {}) {
        const maxBoots = 2;
        for (let boot = 1; boot <= maxBoots; boot++) {
            const result = await this._bootTmuxSessionOnce(sessionName, repoPath, cliCmd, sessionKey, cliType, extraEnv);
            if (!result.ok) return result;
            if (await this._probeInputLiveness(sessionName, cliType)) return result;
            this.logger.error(`${cliType} booted with an unresponsive TUI (boot ${boot}/${maxBoots}) — killing ${sessionName}`);
            try {
                execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
            } catch {
                // already gone
            }
            if (boot === maxBoots) {
                // Report as fatal so the chain walker posts a Slack notice and,
                // on a multi-CLI chain, tries the next provider.
                return { ok: false, fatalError: `${cliType} booted but never accepted input (${maxBoots} attempts)` };
            }
            this.logger.info(`Relaunching ${sessionName} (cli=${cliType}) after unresponsive boot`);
        }
        // Unreachable — the loop either returns or exhausts maxBoots above.
        return { ok: false, fatalError: null };
    }

    // Type one harmless character and require the input box to change. Cheap,
    // CLI-agnostic (each adapter's prompt char is handled by _composerBlock)
    // and decisive: a live TUI echoes within a frame or two. The sentinel is
    // cleared afterwards so the caller starts from an empty composer.
    async _echoesKeystroke(sessionName, timeoutMs = 6000) {
        const before = this._composerBlock(this._captureOutput(sessionName));
        try {
            execSync(`tmux send-keys -t ${sessionName} -l "."`);
        } catch {
            return false; // pane already gone
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 400));
            const now = this._composerBlock(this._captureOutput(sessionName));
            if (now !== null && now !== before) {
                await this._clearComposer(sessionName);
                return true;
            }
        }
        return false;
    }

    async _probeInputLiveness(sessionName, cliType = 'claude', timeoutMs = 6000) {
        if (await this._echoesKeystroke(sessionName, timeoutMs)) {
            this.logger.debug(`Input liveness confirmed for ${sessionName} (cli=${cliType})`);
            return true;
        }

        // Not echoing — but a startup approval dialog swallows keystrokes
        // exactly like a wedged TUI does, and unlike a wedge it is recoverable:
        // Enter accepts the highlighted option (always the "yes, I trust …"
        // one). Claude's managed-settings and folder-trust dialogs are TALLER
        // than an 80x24 detached pane, so their `1. Yes …` lines render BELOW
        // the fold — invisible to the adapter's confirmationPrompts and to
        // _autoApprove, which is why the poller never rescued these boots.
        // Match the header text that does stay on screen. Accepting is
        // consistent with how these sessions are launched anyway
        // (--dangerously-skip-permissions).
        const startupDialogs = [
            /Managed settings require approval/i,
            /Only accept if you trust your organization/i,
            /trust (this|the) folder/i,
            /Is this a project you created or one you trust\?/i,
        ];
        const output = this._captureOutput(sessionName);
        const matched = startupDialogs.find(re => re.test(output));
        if (matched) {
            this.logger.warn(`Startup approval dialog blocking input in ${sessionName} (${matched}) — accepting the highlighted option`);
            try {
                execSync(`tmux send-keys -t ${sessionName} Enter`);
            } catch {
                return false;
            }
            await new Promise(r => setTimeout(r, 1500));
            if (await this._echoesKeystroke(sessionName, timeoutMs)) {
                this.logger.info(`Input liveness confirmed for ${sessionName} after clearing a startup dialog`);
                return true;
            }
        }

        // No input box anywhere in the capture — this CLI's pane shape isn't
        // one _composerBlock can read, so there is nothing to compare and no
        // verdict to give. Assume live: killing a session we cannot judge would
        // turn an unparsed pane layout into an outage for that whole CLI.
        if (this._composerBlock(output) === null) {
            this.logger.warn(`No input box found in ${sessionName} pane (cli=${cliType}) — skipping the liveness verdict`);
            return true;
        }

        this.logger.warn(`No keystroke echo within ${timeoutMs}ms for ${sessionName} (cli=${cliType}) — TUI is not reading input`);
        return false;
    }

    async _bootTmuxSessionOnce(sessionName, repoPath, cliCmd, sessionKey = null, cliType = 'claude', extraEnv = {}) {
        try {
            execSync('which tmux', { stdio: 'ignore' });
        } catch {
            this.logger.error('tmux is not installed');
            return { ok: false, fatalError: null };
        }

        // Kill existing session with same name if any
        try {
            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
            execSync(`tmux kill-session -t ${sessionName}`);
        } catch {
            // Session doesn't exist
        }

        return new Promise((resolve) => {
            const { buildTmuxCommand } = require('../../utils/tmux-helper');
            const cmd = buildTmuxCommand(sessionName, repoPath, cliCmd, sessionKey, cliType, extraEnv);
            this.logger.info(`Creating tmux session (cli=${cliType}): ${cmd}`);

            exec(cmd, (error) => {
                if (error) {
                    this.logger.error(`Failed to create tmux session: ${error.message}`);
                    resolve({ ok: false, fatalError: null });
                    return;
                }
                // Poll until the CLI's TUI reports ready. Each adapter defines
                // its own readiness probe because Claude Code and Codex render
                // very different footers (e.g. Codex's prompt is `› <placeholder>`
                // on the same line, and Codex may still be loading MCP servers).
                const readyAdapter = getCliAdapter(cliType);
                const maxWaitMs = readyAdapter.readinessTimeoutMs || 30000;
                const fatalPatterns = readyAdapter.fatalErrorPatterns || [];
                const pollIntervalMs = 1000;
                // For adapters with requireStableReady (Codex): a passing
                // isReady() capture is only trusted once a second capture
                // taken stableCheckMs later is byte-identical. Codex prints
                // its "Under-development features enabled" banner
                // asynchronously after the prompt renders — a ready verdict
                // taken before the banner lands is followed by a redraw that
                // swallows Enter (incident Q15I3FLETD2FNC, 2026-06-09).
                const stableCheckMs = 2500;
                let lastReadyOutput = null;
                let elapsed = 0;
                const poll = () => {
                    elapsed += pollIntervalMs;
                    try {
                        const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -200`, {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        });
                        // Fatal error takes precedence over readiness — e.g. Codex
                        // can render its prompt briefly before the quota banner
                        // takes over. Abort fast so the fallback CLI can start.
                        const fatal = fatalPatterns.find(p => p.regex.test(output));
                        if (fatal) {
                            this.logger.warn(`${cliType} fatal error detected (${fatal.reason}) after ${elapsed}ms — killing tmux session ${sessionName}`);
                            try {
                                execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
                            } catch {
                                // Already dead
                            }
                            resolve({ ok: false, fatalError: fatal.reason });
                            return;
                        }
                        if (readyAdapter.isReady && readyAdapter.isReady(output)) {
                            if (readyAdapter.requireStableReady && output !== lastReadyOutput) {
                                // First ready capture, or the pane changed since the
                                // last one — a late banner may still be printing.
                                // Re-capture after stableCheckMs and require an
                                // identical pane before trusting readiness. The
                                // readinessTimeoutMs backstop still applies.
                                this.logger.debug(`${cliType} ready signal seen at ${elapsed}ms — verifying pane is stable`);
                                lastReadyOutput = output;
                                elapsed += stableCheckMs - pollIntervalMs;
                                setTimeout(poll, stableCheckMs);
                                return;
                            }
                            this.logger.info(`${cliType} ready after ${elapsed}ms`);
                            const grace = readyAdapter.postReadyGraceMs || 0;
                            if (grace > 0) {
                                this.logger.debug(`Post-ready grace: waiting ${grace}ms for ${cliType} TUI to settle`);
                                setTimeout(() => resolve({ ok: true, fatalError: null }), grace);
                            } else {
                                resolve({ ok: true, fatalError: null });
                            }
                            return;
                        }
                        // Not ready (e.g. the banner guard kicked in) — any
                        // earlier ready capture is stale, start stability over.
                        lastReadyOutput = null;
                    } catch {
                        // capture failed, keep polling
                    }
                    if (elapsed >= maxWaitMs) {
                        this.logger.warn(`${cliType} readiness timeout after ${maxWaitMs}ms, proceeding anyway`);
                        resolve({ ok: true, fatalError: null });
                        return;
                    }
                    setTimeout(poll, pollIntervalMs);
                };
                // Initial delay before first poll
                setTimeout(poll, pollIntervalMs);
            });
        });
    }

    // Walk a CLI preference chain (e.g. ['codex', 'claude']) and try each in
    // order until one boots cleanly. If a CLI hits a fatal startup error
    // (quota exceeded, etc.) we kill its tmux session and fire onFallback so
    // the caller can post a Slack notice before trying the next CLI.
    //
    // Returns:
    //   { ok: true,  cliType: 'claude', fellBackFrom: 'codex' | null, remainingChain: ['claude', ...] }
    //   { ok: false, cliType: <last tried>, fatalError: string | null }
    //
    // `remainingChain` starts at the resolved CLI and includes any CLIs that
    // weren't tried yet. The caller can use it to fall back further if the
    // resolved CLI later fails to accept input (e.g. paste rejection).
    async _startCliWithFallback({ sessionName, repoPath, sessionKey, cliChain, onFallback, resumeIdForFirst = null }) {
        const chain = (cliChain || []).filter(Boolean);
        if (chain.length === 0) chain.push('claude');

        let fellBackFrom = null;
        for (let i = 0; i < chain.length; i++) {
            const cliType = chain[i];
            const adapter = getCliAdapter(cliType);
            // Resume only on the first attempt and only for the saved CLI —
            // a fallback CLI's session id wouldn't apply.
            let cliCmd = null;
            let resumed = false;
            if (i === 0 && resumeIdForFirst && typeof adapter.buildResumeCommand === 'function') {
                cliCmd = adapter.buildResumeCommand(resumeIdForFirst);
                if (cliCmd) {
                    resumed = true;
                    this.logger.info(`Resuming ${cliType} session ${resumeIdForFirst} for ${sessionName}`);
                }
            }
            if (!cliCmd) {
                cliCmd = adapter.buildLaunchCommand(sessionName, repoPath, sessionKey);
            }

            const launchAttempt = async () => {
                let launchCmd = cliCmd;
                // MCP slack-ask wiring: ask the adapter for a per-session launch
                // flag + env. Stubs return empty strings/objects, so this is a
                // no-op when MCP is disabled or the adapter hasn't implemented it.
                const mcp = require('../../mcp');
                const mcpServerUrl = mcp.getServerUrl ? mcp.getServerUrl() : null;
                let extraEnv = {};
                if (mcpServerUrl && typeof adapter.installMcp === 'function') {
                    try {
                        const mcpInstall = adapter.installMcp({ sessionKey, mcpServerUrl });
                        if (mcpInstall.launchFlag) launchCmd = `${launchCmd} ${mcpInstall.launchFlag}`;
                        if (mcpInstall.launchEnv) extraEnv = mcpInstall.launchEnv;
                    } catch (err) {
                        this.logger.warn(`mcp installMcp failed for ${cliType}/${sessionName}: ${err.message}`);
                    }
                }
                // Per-CLI static launch env (e.g. Gemini's egress proxy to
                // bypass Google's geo-block). Stubs/absent method = no-op.
                if (typeof adapter.extraLaunchEnv === 'function') {
                    try {
                        const envOverrides = adapter.extraLaunchEnv();
                        if (envOverrides && typeof envOverrides === 'object') {
                            extraEnv = { ...extraEnv, ...envOverrides };
                        }
                    } catch (err) {
                        this.logger.warn(`extraLaunchEnv failed for ${cliType}/${sessionName}: ${err.message}`);
                    }
                }
                return this._createTmuxSessionDetailed(sessionName, repoPath, launchCmd, sessionKey, cliType, extraEnv);
            };

            const result = adapter.serializeLaunches
                ? await this._runSerializedCliLaunch(cliType, sessionName, launchAttempt)
                : await launchAttempt();

            if (result.ok) {
                return { ok: true, cliType, fellBackFrom, remainingChain: chain.slice(i), resumed };
            }

            // Non-fatal failure (tmux not installed, launch error) — stop the
            // chain. Only recover from adapter-declared fatal errors.
            if (!result.fatalError) {
                return { ok: false, cliType, fatalError: null };
            }

            // Fatal — notify caller so they can post a Slack note, then try next.
            const next = chain[i + 1];
            if (onFallback) {
                try {
                    await onFallback({ failedCli: cliType, nextCli: next || null, reason: result.fatalError });
                } catch (err) {
                    this.logger.error(`Fallback notifier threw: ${err.message}`);
                }
            }
            if (!next) {
                return { ok: false, cliType, fatalError: result.fatalError };
            }
            fellBackFrom = fellBackFrom || cliType;
        }

        return { ok: false, cliType: chain[chain.length - 1], fatalError: null };
    }

    async _runSerializedCliLaunch(cliType, sessionName, launchAttempt) {
        if (!this._serializedCliLaunches) this._serializedCliLaunches = new Map();
        const previous = this._serializedCliLaunches.get(cliType) || Promise.resolve();
        let waited = false;
        const run = previous.catch(() => {}).then(async () => {
            if (waited) {
                this.logger.info(`Serialized ${cliType} launch starting for ${sessionName}`);
            }
            return launchAttempt();
        });
        const tail = run.catch(() => {});
        if (this._serializedCliLaunches.has(cliType)) {
            waited = true;
            this.logger.info(`Serializing ${cliType} launch for ${sessionName} until prior launch finishes MCP startup`);
        }
        this._serializedCliLaunches.set(cliType, tail);
        try {
            return await run;
        } finally {
            if (this._serializedCliLaunches.get(cliType) === tail) {
                this._serializedCliLaunches.delete(cliType);
            }
        }
    }

    // Bounded retry of a whole alert investigation when the CLI chain is
    // exhausted and injection still failed (paste never landed / no turn
    // progress = startup-race under host load). Tears down the dead tmux row and
    // re-triggers _processCommand from scratch after a short delay so the CLI
    // boots on a (hopefully) less-loaded box. Returns true if a retry was
    // scheduled — the caller should NOT give up. Returns false when the retry
    // budget is spent — the caller posts the give-up notice.
    _retryAlertInvestigation({ channelId, threadTs, command, messageTs, alertMessageTs, userId, cliChainHint, reason }) {
        const sessionKey = `${channelId}-${threadTs}`;
        const maxRetries = this.config.alertSilentMaxRetries ?? 2;
        const used = this._alertInjectRetries.get(sessionKey) || 0;
        if (used >= maxRetries) {
            this._alertInjectRetries.delete(sessionKey);
            this.logger.error(`Alert inject-retry: giving up for ${sessionKey} after ${used} retr${used === 1 ? 'y' : 'ies'} (${reason})`);
            return false;
        }
        this._alertInjectRetries.set(sessionKey, used + 1);

        // Tear down the dead session so re-entry spins up a fresh tmux + CLI.
        const session = this._getSession(sessionKey);
        if (session) {
            const killCmd = 'tmux kill-session -t ' + session.sessionName + ' 2>/dev/null';
            try { execSync(killCmd); } catch { /* already gone */ }
        }
        this._clearSessionTimeout(sessionKey);
        this._deleteSession(sessionKey);

        // Keep 👀 on the alert (don't flip to ❌) — still being worked.
        const total = maxRetries + 1;          // original attempt + retries
        const attemptLabel = used + 2;          // human: 2nd, 3rd, ... attempt
        const delayMs = 30000;
        this.app.client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `:repeat: CLI never accepted the prompt (${reason}) — likely a startup race under load. Retrying investigation (attempt ${attemptLabel}/${total}) in ${Math.round(delayMs / 1000)}s.`,
        }).catch(err => this.logger.error(`Failed to post inject-retry notice: ${err.message}`));

        setTimeout(() => {
            this._processCommand(channelId, threadTs, command, null, messageTs, alertMessageTs, userId, cliChainHint)
                .catch(err => this.logger.error(`Alert inject-retry re-trigger failed for ${sessionKey}: ${err.message}`));
        }, delayMs);
        this.logger.warn(`Alert inject-retry: scheduled attempt ${attemptLabel}/${total} for ${sessionKey} in ${delayMs}ms (${reason})`);
        return true;
    }

    // ─── Local TUI commands (/model & friends) ───────────────────────────────
    //
    // Inject a LOCAL command — one that runs inside the CLI's TUI without
    // starting an assistant turn — and return the pane content after it
    // settles. Deliberately NOT _injectCommand: that path presses Enter up to
    // 7 times until a working indicator appears, which is correct for real
    // prompts but catastrophic for local commands that open a selection
    // dialog — each retry Enter "picks" the highlighted entry (a bare /model
    // injected that way rewrote the owner's default model, 2026-07-02).
    // Here: paste with landing verification, exactly ONE Enter, capture.
    // sessionName is bot-generated (`slack-<chan>-<ts>`), never user input;
    // the pasted text goes through a temp file + tmux load-buffer, so no part
    // of it is ever interpolated into a shell string.
    async _injectLocalCommand(sessionName, text, settleMs = 3000) {
        const os = require('os');
        const tmpFile = path.join(os.tmpdir(), `cli-local-inject-${sessionName}-${Date.now()}.txt`);
        try {
            fs.writeFileSync(tmpFile, text);
            // Whitespace-squashed match for the same reason as _injectCommand's
            // probe: the composer word-wraps, so a contiguous substring match
            // can miss a paste that is sitting right there in the input box.
            const squash = (s) => (s || '').replace(/\s+/g, '');
            const probe = squash(text.split('\n')[0].trim().substring(0, 40));
            let pasteLanded = false;
            for (let attempt = 0; attempt < 4; attempt++) {
                execSync(`tmux send-keys -t ${sessionName} C-u`);
                await new Promise(r => setTimeout(r, 200));
                execSync(`tmux load-buffer ${tmpFile}`);
                execSync(`tmux paste-buffer -t ${sessionName}`);
                await new Promise(r => setTimeout(r, 1000 + attempt * 500));
                if (probe.length >= 2 && squash(this._captureOutput(sessionName)).includes(probe)) {
                    pasteLanded = true;
                    break;
                }
            }
            if (!pasteLanded) {
                throw new Error('paste did not land — the CLI may be busy or still initializing');
            }
            execSync(`tmux send-keys -t ${sessionName} Enter`);
            await new Promise(r => setTimeout(r, settleMs));
            return this._captureOutput(sessionName);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    // /model — handled entirely bot-side (see the intercept in _processCommand
    // for why it must never reach the generic inject path). Three shapes:
    //   /model            → report the current model parsed from the pane
    //                       footer; never inject (the no-arg form opens the
    //                       interactive picker).
    //   /model <name>     → inject the CLI's inline form via
    //                       _injectLocalCommand, scrape the "Set model to …"
    //                       confirmation, and post it — no Stop hook fires
    //                       for local commands, so the bot must post itself.
    //   unsupported CLI   → Codex/Gemini have picker-only /model; tell the
    //                       user to /exit and relaunch instead.
    async _handleModelCommand({ sessionKey, channelId, threadTs, messageTs, command, session, isLiveSession, restricted }) {
        const post = async (text) => {
            try {
                const res = await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
                // This path bypasses cli-hook-notify.js, which normally keeps
                // last_bot_ts fresh — update it here so the silent-alert
                // requeue and inactivity sweeps don't misread the session as
                // never-answered (same class of bug as the ask_user posts).
                if (session && res?.ts) this._updateLastBotTs(sessionKey, res.ts);
            } catch (err) {
                this.logger.error(`Failed to post /model reply (channel=${channelId}): ${err.message}`);
            }
        };

        // Switching the model persists as the owner's CLI default ("saved as
        // your default for new sessions"), so restricted (non-owner) users
        // may not touch it.
        if (restricted) {
            await post('`/model` is limited to the bot owner.');
            return;
        }
        if (!session || !isLiveSession) {
            await post('No active session in this thread — `/model` needs a live session. Send a message first to start one.');
            return;
        }

        const cliType = session.cliType || 'claude';
        const adapter = getCliAdapter(cliType);
        const arg = command.split(/\s+/).slice(1).join(' ').trim();

        if (!adapter.supportsModelSwitch) {
            await post(`Mid-session model switch isn't supported for \`${cliType}\` (its /model is an interactive picker only). \`/exit\` and start a new session — the model is chosen at launch.`);
            return;
        }

        this._touchSession(sessionKey);

        if (!arg) {
            const stats = this._extractSessionStats(this._captureOutput(session.sessionName) || '');
            const current = stats && stats.model
                ? `Current model: *${stats.model}*.`
                : 'Couldn\'t read the current model from the session pane.';
            await post(`${current} To switch: \`/model opus\`, \`/model sonnet\`, \`/model haiku\`, \`/model fable\`, or a full id like \`/model claude-opus-4-8\`.`);
            return;
        }

        // Whitelist charset (same rationale as SLACK_CLAUDE_MODEL in the
        // claude adapter): the arg ends up in a tmux paste, keep it inert.
        if (!/^[A-Za-z0-9._:/-]{1,60}$/.test(arg)) {
            await post(`\`${arg}\` doesn't look like a model name. Try \`/model opus\`, \`/model sonnet\`, or a full model id.`);
            return;
        }

        try {
            let output = await this._injectLocalCommand(session.sessionName, `/model ${arg}`);
            const confirmRe = adapter.modelSwitchConfirmRegex || /Set model to/i;
            const outcomeVisible = (out) =>
                confirmRe.test(out) || /Switch model\?/i.test(out) || /not found/i.test(out);
            // A loaded host can render the outcome (confirm line, cache
            // dialog, or error) later than the inject settle — re-capture a
            // few beats before concluding anything.
            for (let i = 0; i < 3 && !outcomeVisible(output); i++) {
                await new Promise(r => setTimeout(r, 2000));
                output = this._captureOutput(session.sessionName);
            }
            // Switching away from the current model mid-conversation pops a
            // "Switch model?" cache-invalidation confirm (1. Yes / 2. No —
            // verified on 2.1.198). The user explicitly asked, so approve it
            // the same way _autoApprove does: digit, then Enter.
            if (/Switch model\?/i.test(output) && output.includes('1. Yes')) {
                execSync(`tmux send-keys -t ${session.sessionName} 1`);
                await new Promise(r => setTimeout(r, 300));
                execSync(`tmux send-keys -t ${session.sessionName} Enter`);
                for (let i = 0; i < 4; i++) {
                    await new Promise(r => setTimeout(r, 1500));
                    output = this._captureOutput(session.sessionName);
                    if (confirmRe.test(output)) break;
                }
            }
            const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
            const stripChrome = (l) => l.replace(/^[⎿⏺●➤\s]+/, '');
            const confirmLine = [...lines].reverse().find(l => confirmRe.test(l));
            if (confirmLine) {
                await post(`:white_check_mark: ${stripChrome(confirmLine)}`);
                return;
            }
            // Unknown name: the CLI prints `Model '<arg>' not found` inline.
            const notFound = [...lines].reverse().find(l => /Model '.*' not found/i.test(l));
            if (notFound) {
                await post(`:x: ${stripChrome(notFound)}. Try \`/model opus\`, \`/model sonnet\`, \`/model haiku\`, \`/model fable\`, or a full model id.`);
                return;
            }
            // Neither confirmation nor a recognizable error — if some dialog
            // is open, close it (Escape) so a modal doesn't eat the next
            // inject's paste, then report what the pane showed.
            execSync(`tmux send-keys -t ${session.sessionName} Escape`);
            await new Promise(r => setTimeout(r, 300));
            execSync(`tmux send-keys -t ${session.sessionName} C-u`);
            const tail = lines.slice(-5).join('\n');
            await post(`Model switch to \`${arg}\` wasn't confirmed by the CLI. Pane tail:\n\`\`\`\n${tail}\n\`\`\``);
        } catch (err) {
            await post(`Failed to send \`/model ${arg}\` to the session: ${err.message}`);
        }
    }

    // Generic driver for read-only local commands (see CLAUDE_* constants and
    // adapter.localSlashCommands).
    // kind='panel': the command opens a read-only dialog — scrape it from the
    // pane, post it, close it with Esc so the modal can't eat the next
    // inject's paste. kind='print': the result lands inline in the
    // transcript — scrape everything below the command echo.
    async _handleCliLocalCommand({ sessionKey, channelId, threadTs, command, firstToken, session, isLiveSession, restricted, kind }) {
        const post = async (text) => {
            try {
                const res = await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
                // Bypasses cli-hook-notify.js (which normally maintains
                // last_bot_ts) — keep it fresh for the requeue/inactivity sweeps.
                if (session && res?.ts) this._updateLastBotTs(sessionKey, res.ts);
            } catch (err) {
                this.logger.error(`Failed to post ${firstToken} reply (channel=${channelId}): ${err.message}`);
            }
        };

        // Panels expose host/account details (email, permission rules, MCP
        // servers) and /clear//compact mutate the owner's session — all of it
        // is owner-only under the restricted-access model.
        if (restricted) {
            await post(`\`${firstToken}\` is limited to the bot owner.`);
            return;
        }
        if (!session || !isLiveSession) {
            await post(`No active session in this thread — \`${firstToken}\` needs a live session. Send a message first to start one.`);
            return;
        }

        this._touchSession(sessionKey);

        if ((session.cliType || 'claude') === 'codex' && firstToken === '/model') {
            await this._handleCodexModelCommand({ sessionKey, session, command, post });
            return;
        }

        try {
            let output = await this._injectLocalCommand(session.sessionName, command, 4000);

            // /compact re-summarizes the whole conversation — it can spin for
            // minutes on a fat context. Poll until the working indicators
            // clear (or 3 min) before scraping.
            if (firstToken === '/compact') {
                const adapter = getCliAdapter(session.cliType || 'claude');
                const deadline = Date.now() + 180000;
                const busy = (text) => {
                    const lower = (text || '').toLowerCase();
                    return (adapter.workingIndicators || []).some(i => lower.includes(i))
                        || (adapter.workingRegexes || []).some(re => re.test(lower));
                };
                while (busy(output) && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 3000));
                    output = this._captureOutput(session.sessionName);
                }
            }

            let result = this._scrapeLocalCommandResult(output, firstToken);

            if (kind === 'panel') {
                execSync(`tmux send-keys -t ${session.sessionName} Escape`);
                await new Promise(r => setTimeout(r, 500));
                execSync(`tmux send-keys -t ${session.sessionName} Escape`);
                await new Promise(r => setTimeout(r, 300));
                execSync(`tmux send-keys -t ${session.sessionName} C-u`);
            }

            if (!result && firstToken === '/clear') {
                await post(':white_check_mark: Conversation cleared — the session starts fresh from the next message.');
                return;
            }
            if (!result) {
                await post(`\`${command}\` ran but produced no visible output.`);
                return;
            }
            // Slack chat.postMessage caps text at 4000 chars — leave headroom
            // for the header and code fences.
            const MAX = 3500;
            if (result.length > MAX) {
                result = `${result.slice(0, MAX)}\n… (truncated)`;
            }
            await post(`Output of \`${command}\`:\n\`\`\`\n${result}\n\`\`\``);
        } catch (err) {
            await post(`Failed to run \`${command}\` in the session: ${err.message}`);
        }
    }

    async _handleClaudeLocalCommand(args) {
        return this._handleCliLocalCommand(args);
    }

    async _handleCodexModelCommand({ sessionKey, session, command, post }) {
        const arg = command.split(/\s+/).slice(1).join(' ').trim();
        const closePicker = async () => {
            execSync(`tmux send-keys -t ${session.sessionName} Escape`);
            await new Promise(r => setTimeout(r, 500));
            execSync(`tmux send-keys -t ${session.sessionName} Escape`);
            await new Promise(r => setTimeout(r, 300));
            execSync(`tmux send-keys -t ${session.sessionName} C-u`);
        };

        try {
            let output = await this._injectLocalCommand(session.sessionName, '/model', 4000);
            let options = this._parseCodexModelOptions(output);

            if (!arg) {
                await closePicker();
                if (!options.length) {
                    const result = this._scrapeLocalCommandResult(output, '/model');
                    await post(result
                        ? `Output of \`/model\`:\n\`\`\`\n${result}\n\`\`\``
                        : '`/model` opened, but I could not read any model options from the pane.');
                    return;
                }

                this._codexModelOptions = this._codexModelOptions || new Map();
                this._codexModelOptions.set(sessionKey, options.map(o => ({ number: o.number, label: o.label })));

                const body = options
                    .map((o) => `${o.number || '?'}. ${o.label}${o.selected ? ' (current)' : ''}`)
                    .join('\n');
                await post(`Codex model picker:\n\`\`\`\n${body}\n\`\`\`\nReply with \`/model <number>\` or \`/model <model text>\` to choose.`);
                return;
            }

            if (!options.length) {
                await closePicker();
                await post('`/model` opened, but I could not read the model list well enough to select safely.');
                return;
            }

            let targetIndex = -1;
            if (/^\d+$/.test(arg)) {
                const requestedNumber = Number(arg);
                targetIndex = options.findIndex(o => o.number === requestedNumber);
            } else {
                const needle = arg.toLowerCase();
                targetIndex = options.findIndex(o => o.label.toLowerCase() === needle);
                if (targetIndex < 0) {
                    targetIndex = options.findIndex(o => o.label.toLowerCase().includes(needle));
                }
            }

            if (targetIndex < 0 || targetIndex >= options.length) {
                await closePicker();
                await post(`I couldn't match \`${arg}\` to a visible Codex model option. Run \`/model\` again and choose one of the numbered entries.`);
                return;
            }

            const selectedIndex = options.findIndex(o => o.selected);
            if (selectedIndex < 0) {
                await closePicker();
                await post('I could read the model list, but not the currently highlighted option. I did not select anything; run `/model` again and choose from the fully visible list.');
                return;
            }
            const delta = targetIndex - selectedIndex;
            const key = delta >= 0 ? 'Down' : 'Up';
            for (let i = 0; i < Math.abs(delta); i++) {
                execSync(`tmux send-keys -t ${session.sessionName} ${key}`);
                await new Promise(r => setTimeout(r, 120));
            }
            execSync(`tmux send-keys -t ${session.sessionName} Enter`);
            await new Promise(r => setTimeout(r, 2500));

            output = this._captureOutput(session.sessionName) || '';
            const stats = this._extractSessionStats(output);
            const current = stats && stats.model ? ` Current pane model: *${stats.model}*.` : '';
            await post(`:white_check_mark: Selected Codex model option ${options[targetIndex].number || targetIndex + 1}: *${options[targetIndex].label}*.${current}`);
        } catch (err) {
            try {
                execSync(`tmux send-keys -t ${session.sessionName} Escape`);
                execSync(`tmux send-keys -t ${session.sessionName} C-u`);
            } catch { /* ignore cleanup failure */ }
            await post(`Failed to handle Codex \`/model\`: ${err.message}`);
        }
    }

    _parseCodexModelOptions(output) {
        const result = this._scrapeLocalCommandResult(output, '/model');
        const lines = (result || '').split('\n').map(l => l.trim()).filter(Boolean);
        const numbered = [];
        let current = null;

        for (const line of lines) {
            const numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
            if (numberedMatch) {
                if (current) numbered.push(current);
                const selected = /\bcurrent\b/i.test(numberedMatch[2]);
                current = {
                    number: Number(numberedMatch[1]),
                    label: numberedMatch[2].replace(/\s+\bcurrent\b/i, '').replace(/\s{2,}/g, ' ').trim(),
                    selected,
                };
                continue;
            }
            if (current) {
                if (/^(press enter|esc|select model|access legacy|model:|directory:|permissions:)/i.test(line)) continue;
                current.label = `${current.label} ${line}`.replace(/\s{2,}/g, ' ').trim();
            }
        }
        if (current) numbered.push(current);
        if (numbered.length) return numbered;

        const options = [];
        for (const line of lines) {
            if (!/(^|[^a-z])(gpt-|o[0-9]|auto\b)/i.test(line)) continue;
            if (/openai codex|^model:|directory:|permissions:|context|usage|run \/status/i.test(line)) continue;

            const selected = /^[^\w]*(?:[●>›❯*]|=>)/.test(line);
            const label = line
                .replace(/^[^\w]*(?:[●○>›❯*]|=>)?\s*/, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (!label || options.some(o => o.label === label)) continue;
            options.push({ number: options.length + 1, label, selected });
        }

        return options;
    }

    // Extract the interesting region of a pane capture after a local command
    // ran. Panels render below a long ▔▔▔ top border; inline prints land
    // directly under the `❯ /cmd` echo line and stop at the input-box
    // divider. Falls back to the pane tail when neither shape is found.
    // Footer chrome (OMC HUD, cwd/branch line, bypass-permissions hint) is
    // filtered wherever it appears — the stop divider doesn't always render
    // by capture time, and leaked chrome confused the first live test.
    _scrapeLocalCommandResult(output, firstToken) {
        const lines = (output || '').split('\n');
        const CHROME = [
            /^\[OMC#/,                    // OMC HUD statusline
            /bypass permissions/i,        // ⏵⏵ bypass permissions on …
            /^⏵/,
            /^\/.*\|\s*repo:/,            // cwd | repo:… footer line
            /^branch:/,                   // branch:… | !4 ?1 footer line
            /^\d+h:\d+%/,                 // 5h:58%(1h40m) wk:… usage HUD
            /Esc to (cancel|close)/i,
        ];
        const isChrome = (l) => CHROME.some(re => re.test(l.trim()));
        const clean = (arr) => arr
            .filter(l => !isChrome(l))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const lastIndex = (pred) => {
            for (let i = lines.length - 1; i >= 0; i--) {
                if (pred(lines[i])) return i;
            }
            return -1;
        };

        const panelTop = lastIndex(l => /^▔{10,}/.test(l.trim()));
        if (panelTop >= 0) {
            return clean(lines.slice(panelTop + 1));
        }

        const tokenRe = firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const echoRe = new RegExp(`^[❯›>]\\s+${tokenRe}(?:\\s|$)`);
        const echo = lastIndex(l => echoRe.test(l.trim()));
        if (echo >= 0) {
            const after = lines.slice(echo + 1);
            const stop = after.findIndex(l => /^─{10,}/.test(l.trim()) || /^❯\s*$/.test(l.trim()));
            return clean(stop >= 0 ? after.slice(0, stop) : after);
        }

        return clean(lines.slice(-25));
    }

    // Detects an unsent paste still sitting in the CLI's composer — the
    // fingerprint of a swallowed Enter. Codex renders unsubmitted pasted input as
    // "› [Pasted Content N chars]" ON the composer prompt line; once the command
    // is actually submitted that placeholder scrolls up into history, off the
    // prompt line, and the composer returns to its empty greyed hint. Anchoring
    // the match to the prompt char (`›`/`❯`/`>`) means we only flag content that
    // is still in the input box — never a message that already went through — so
    // callers can safely treat a hit as "the command was pasted but never sent".
    _pasteStuckInComposer(output, adapter) {
        const indicators = (adapter && adapter.pasteLandedIndicators) || [];
        if (!indicators.length) return false;
        // The live composer is the BOTTOM-most prompt line — history prompts sit
        // above it (Codex echoes a submitted user message as its own "› …" line,
        // so matching any prompt line would false-positive on an already-sent
        // command). Only an unsent paste lands in the composer, so check just it.
        let composer = null;
        for (const line of (output || '').split('\n')) {
            if (/^[)❯>›]/.test(line.trim())) composer = line;
        }
        if (composer === null) return false;
        return indicators.some(p =>
            typeof p === 'string' ? composer.includes(p) : p.test(composer)
        );
    }

    // The CLI's input box as rendered: the last line starting with a prompt
    // char, plus the wrapped continuation lines under it, up to the box's
    // closing rule. Used to tell "something is sitting in the composer" from
    // "the composer is empty" without depending on the pasted text being
    // matchable — the box word-wraps, scrolls internally once the content is
    // taller than the box, and collapses big pastes behind a placeholder, so
    // no substring probe is reliable on its own.
    _composerBlock(output) {
        const lines = (output || '').split('\n');
        let start = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (/^\s*[❯>›)]/.test(lines[i])) { start = i; break; }
        }
        if (start === -1) return null;
        const block = [];
        for (let i = start; i < lines.length; i++) {
            if (i > start && /^\s*─{20,}\s*$/.test(lines[i])) break;
            block.push(i === start ? lines[i].replace(/^\s*[❯>›)]\s?/, '') : lines[i]);
        }
        const flat = block.join('').replace(/\s+/g, '');
        // The ghost placeholder ("Try \"write a test for …\"") means the box is
        // EMPTY. Its hint text rotates between renders, so treating it as
        // content would fake a "composer changed" signal on every retry.
        if (!flat || /^Try"/.test(flat)) return '';
        return flat;
    }

    // Empty the CLI's input box. `C-u` alone cannot do it: it kills the
    // CURRENT VISUAL LINE, and once the cursor sits at the start of a line it
    // is a no-op — measured on Claude Code 2.1.221, 40 consecutive C-u presses
    // left a 7-line paste half-standing. Pairing each C-u with a BSpace joins
    // the emptied line onto the previous one so the next C-u has something to
    // kill, which does walk the whole buffer back.
    //
    // Stop condition is "the box stopped changing", not "the box is empty":
    // Claude pre-fills a dim next-action suggestion after each turn, and the
    // pane can't distinguish that from typed text. Real content shrinks every
    // batch; a suggestion stays byte-identical.
    async _clearComposer(sessionName, maxBatches = 12) {
        let prev = this._composerBlock(this._captureOutput(sessionName));
        for (let batch = 0; batch < maxBatches; batch++) {
            if (!prev) return;
            try {
                for (let i = 0; i < 5; i++) {
                    execSync(`tmux send-keys -t ${sessionName} C-u`);
                    execSync(`tmux send-keys -t ${sessionName} BSpace`);
                    await new Promise(r => setTimeout(r, 60));
                }
            } catch {
                return; // pane gone — the caller's own checks will surface it
            }
            await new Promise(r => setTimeout(r, 300));
            const now = this._composerBlock(this._captureOutput(sessionName));
            if (!now || now === prev) return;
            prev = now;
        }
    }

    async _injectCommand(sessionName, command, cliType = 'claude') {
        const os = require('os');
        const adapter = getCliAdapter(cliType);
        const excludePatterns = adapter.workingExcludePatterns || [];
        const indicatorHit = (text) => {
            // Strip lines the adapter declares as chrome (e.g. Codex MCP startup
            // banner) before matching — otherwise "esc to interrupt" in the
            // banner makes the injector think Codex accepted Enter when it
            // didn't, and the prompt is silently lost.
            const filtered = (text || '')
                .split('\n')
                .filter(l => !excludePatterns.some(re => re.test(l)))
                .join('\n')
                .toLowerCase();
            if (adapter.workingIndicators.some(ind => filtered.includes(ind))) return true;
            return (adapter.workingRegexes || []).some(re => re.test(filtered));
        };
        const tmpFile = path.join(os.tmpdir(), `cli-inject-${sessionName}-${Date.now()}.txt`);
        try {
            // Write command to temp file to avoid shell argument length limits
            fs.writeFileSync(tmpFile, command);

            // Snapshot output before injection so we can detect silent paste loss later.
            const preInjectOutput = this._captureOutput(sessionName);

            // Probe strings used to detect a landed paste in the visible pane.
            // A long command (existing session: self-knowledge preamble +
            // thread-context + "My request: …") pushes its FIRST line off the
            // top of the captured pane, so checking only the first line yields a
            // false "Paste failed after N attempts" even though the paste landed
            // and is sitting in the input box (incident 2026-06-15). The input
            // box always renders the TAIL of a long paste, so also probe the
            // LAST non-empty line. Lines are trimmed (the pane indents pasted
            // input) and 40-char-capped; probes shorter than 4 chars are
            // dropped so a bare `}` can't false-match.
            const probeLines = (() => {
                const lines = command.split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length === 0) return [];
                const probes = [lines[0].substring(0, 40)];
                const last = lines[lines.length - 1].substring(0, 40);
                if (last && last !== probes[0]) probes.push(last);
                return probes.filter(p => p.length >= 4);
            })();
            // Match with ALL whitespace squashed out. The composer word-wraps,
            // so a 40-char probe routinely straddles a wrap and never appears
            // contiguously in the capture — capping the probe is not enough
            // (incident 1785808680, 2026-08-04: an 80-col detached pane broke
            // `could you get file from <https://…` right after "from", the
            // first-line probe had already scrolled out of the input box, and
            // the paste was too small to collapse behind a "Pasted text"
            // placeholder, so all three landing signals missed a paste that
            // was plainly sitting in the composer). Squashing also absorbs the
            // pane's leading indent on pasted input.
            const squash = (s) => (s || '').replace(/\s+/g, '');
            const probeNeedles = probeLines.map(squash).filter(p => p.length >= 4);
            const probeVisible = (out) => {
                const flat = squash(out);
                return probeNeedles.some(p => flat.includes(p));
            };

            // Paste with verification — Claude Code renders ❯ before its TUI input handler
            // finishes initializing. If we paste during that window, tcsetattr(TCSAFLUSH)
            // flushes the pty buffer and our paste is silently lost. Retry until it lands.
            const pasteMaxAttempts = 5;
            let pasteLanded = false;
            // Composer state before the paste. `C-u` kills only the input box's
            // CURRENT VISUAL LINE, so it cannot be relied on to empty a wrapped
            // multi-line paste — comparing against this baseline is how a retry
            // knows the previous attempt actually landed instead of stacking
            // another copy on top of it (2026-08-04: five retries left five
            // truncated copies, and the user's manual Enter submitted them all).
            let composerBefore = this._composerBlock(preInjectOutput);
            if (composerBefore) {
                // Leftovers from an earlier failed inject are still unsent, and
                // one C-u can't remove them — Enter would submit them glued to
                // this prompt. Knock the box down with a bounded burst (one kill
                // per visual line), then re-read the baseline.
                this.logger.warn(`Composer not empty before inject (${composerBefore.length} chars visible) — clearing leftovers for ${sessionName}`);
                await this._clearComposer(sessionName);
                composerBefore = this._composerBlock(this._captureOutput(sessionName));
            }
            for (let attempt = 0; attempt < pasteMaxAttempts; attempt++) {
                // Clear current input (best effort — see composerBefore above)
                execSync(`tmux send-keys -t ${sessionName} C-u`);
                await new Promise(r => setTimeout(r, 200));

                // Load text into tmux paste buffer and paste it
                execSync(`tmux load-buffer ${tmpFile}`);
                execSync(`tmux paste-buffer -t ${sessionName}`);

                // Wait for the TUI to process the bracketed paste
                const baseDelay = 1000;
                const perLineDelay = Math.min(command.split('\n').length * 100, 3000);
                await new Promise(r => setTimeout(r, baseDelay + perLineDelay));

                // Verify paste appeared in the pane — check multiple indicators:
                // 1. Adapter-declared paste banner (Claude: "Pasted text",
                //    Codex: "[Pasted Content N chars]" — different TUIs render
                //    different placeholders, so each adapter declares its own).
                // 2. The first or last line of the command appears in the
                //    visible pane, whitespace-squashed (works only when the TUI
                //    doesn't collapse pastes behind a placeholder; harmless
                //    when it does).
                // 3. The CLI already started working (paste + auto-submit succeeded).
                // 4. The input box now holds something it didn't hold before the
                //    paste. Last-resort signal, but the one that survives word
                //    wrap, internal scrolling and placeholder collapse alike:
                //    if the composer changed and isn't empty, our text is in it.
                const output = this._captureOutput(sessionName);
                const isAlreadyWorking = indicatorHit(output);
                const pasteIndicators = adapter.pasteLandedIndicators || [/Pasted text/i];
                const pasteIndicatorMatched = pasteIndicators.some(p =>
                    typeof p === 'string' ? output.includes(p) : p.test(output)
                );
                const composerNow = this._composerBlock(output);
                const composerGrew = !!composerNow && composerNow !== composerBefore;
                if (pasteIndicatorMatched || probeVisible(output) || isAlreadyWorking || composerGrew) {
                    if (attempt > 0) {
                        this.logger.info(`Paste landed on attempt ${attempt + 1} for ${sessionName}${isAlreadyWorking ? ' (already working)' : ''}`);
                    }
                    pasteLanded = true;
                    break;
                }
                this.logger.warn(`Paste not detected (attempt ${attempt + 1}/${pasteMaxAttempts}), retrying for ${sessionName}`);
                // Increasing backoff — give TUI more time to finish initialization
                await new Promise(r => setTimeout(r, 1000 + attempt * 500));
            }

            if (!pasteLanded) {
                throw new Error(`Paste failed after ${pasteMaxAttempts} attempts — ${cliType} may not be ready`);
            }

            // LAYER 1 GUARD — splash-wipe race protection.
            // Between paste-verify and the first Enter, a still-settling splash
            // banner can redraw and clear the input box (TCSAFLUSH-style flush
            // on TUI init). Enter would then submit empty, Claude would never
            // start a turn, and the Stop hook would never fire. Re-check the
            // pane right before pressing Enter and re-paste if the content is gone.
            {
                const pasteIndicators = adapter.pasteLandedIndicators || [/Pasted text/i];
                const stillVisible = (out) =>
                    pasteIndicators.some(p => typeof p === 'string' ? out.includes(p) : p.test(out))
                    || probeVisible(out)
                    || indicatorHit(out);
                const preEnterOutput = this._captureOutput(sessionName);
                if (!stillVisible(preEnterOutput)) {
                    this.logger.warn(`Input box empty before first Enter — splash redraw wiped paste, re-pasting for ${sessionName}`);
                    execSync(`tmux send-keys -t ${sessionName} C-u`);
                    await new Promise(r => setTimeout(r, 200));
                    execSync(`tmux load-buffer ${tmpFile}`);
                    execSync(`tmux paste-buffer -t ${sessionName}`);
                    await new Promise(r => setTimeout(r, 1500));
                }
            }

            // Send Enter and verify the CLI started processing. 7 attempts
            // with growing waits ≈ 31s total — 5 (~17s) was not enough for a
            // TUI whose submit handler was still mounting on a loaded host
            // (incident Q15I3FLETD2FNC, 2026-06-09).
            const maxAttempts = 7;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                execSync(`tmux send-keys -t ${sessionName} Enter`);
                // Longer wait on later attempts — give Claude Code more time to process
                const waitMs = 1500 + attempt * 1000;
                await new Promise(r => setTimeout(r, waitMs));

                const output = this._captureOutput(sessionName);
                const isWorking = indicatorHit(output);
                // Also check if the CLI already finished (prompt visible again) — means it
                // processed the command very quickly (e.g. "hi") before we could detect working state
                const hasPrompt = /^[)❯>›]\s*$/m.test(output);
                if (isWorking) {
                    if (attempt > 0) {
                        this.logger.info(`Enter accepted on attempt ${attempt + 1} for ${sessionName}`);
                    }
                    return preInjectOutput;
                }
                if (hasPrompt && attempt >= 1) {
                    // Prompt visible after at least 2 Enter attempts — Claude likely processed
                    // the command quickly and is waiting for the next one. The Stop hook
                    // already fired (or will fire), so don't keep retrying.
                    // Guard: if output is essentially unchanged from before injection, the
                    // paste was silently lost (tcsetattr TCSAFLUSH race). Keep retrying.
                    const trimmedPre = preInjectOutput.replace(/\s+/g, ' ').trim();
                    const trimmedNow = output.replace(/\s+/g, ' ').trim();
                    if (trimmedPre === trimmedNow) {
                        this.logger.warn(`Output unchanged after Enter attempt ${attempt + 1} — paste likely lost, re-pasting for ${sessionName}`);
                        // Re-paste the command before next Enter attempt
                        execSync(`tmux send-keys -t ${sessionName} C-u`);
                        await new Promise(r => setTimeout(r, 200));
                        execSync(`tmux load-buffer ${tmpFile}`);
                        execSync(`tmux paste-buffer -t ${sessionName}`);
                        await new Promise(r => setTimeout(r, 1500));
                        continue;
                    }
                    // Enter-swallow guard: a prompt is visible and the pane changed,
                    // but the paste placeholder is STILL in the composer — the Enter
                    // was dropped by a late boot/banner redraw (Codex renders `›`
                    // seconds before its submit handler is live) and the command was
                    // never submitted. An idle composer holding unsent content looks
                    // identical to "returned to prompt after responding", so don't
                    // declare success on hasPrompt alone — press Enter again (the loop
                    // re-sends on the next iteration with a longer settle wait).
                    if (this._pasteStuckInComposer(output, adapter)) {
                        this.logger.warn(`Prompt visible but paste still in composer (Enter swallowed) — re-pressing Enter (attempt ${attempt + 1}) for ${sessionName}`);
                        continue;
                    }
                    this.logger.info(`Prompt visible after Enter attempt ${attempt + 1} — Claude likely already responded for ${sessionName}`);
                    return preInjectOutput;
                }
                this.logger.warn(`Enter not confirmed (attempt ${attempt + 1}/${maxAttempts}), retrying for ${sessionName}`);
            }
            // After all retries, check one final time — if Claude shows prompt, it processed the command
            const finalOutput = this._captureOutput(sessionName);
            const finalHasPrompt = /^[)❯>›]\s*$/m.test(finalOutput);
            // Same Enter-swallow guard as the loop: a bare prompt only means
            // "already responded" if the paste is no longer sitting in the box.
            // If it still is, fall through to the silent-drop detection below,
            // which clears the input and fails loudly (flips the alert to ✗ /
            // triggers requeue) instead of leaving a silently unsent command.
            if (finalHasPrompt && !this._pasteStuckInComposer(finalOutput, adapter)) {
                this.logger.info(`Prompt visible after all Enter attempts — Claude likely already responded for ${sessionName}`);
                return preInjectOutput;
            }
            // Silent-drop detection: a paste is still sitting in the input
            // box and the CLI never started working. This is the failure mode
            // where paste lands but Enter never submits (a late banner redraw
            // swallowed it). Detect via adapter-declared paste indicators or
            // the literal first line — Codex hides the content behind a
            // placeholder, so the indicator regex is the only signal there.
            // Clear the stuck input and fail loudly so the alert reaction
            // flips to ✗ and the user knows.
            const finalFirstLine = command.split('\n')[0].substring(0, 40);
            const finalPasteIndicators = adapter.pasteLandedIndicators || [/Pasted text/i];
            const finalPasteVisible = finalPasteIndicators.some(p =>
                typeof p === 'string' ? finalOutput.includes(p) : p.test(finalOutput)
            );
            const stuckInInput = finalPasteVisible || (finalFirstLine && finalOutput.includes(finalFirstLine));
            if (stuckInInput && !indicatorHit(finalOutput)) {
                try { execSync(`tmux send-keys -t ${sessionName} C-u`); } catch { /* ignore */ }
                this.logger.error(`Enter dropped — command still in ${cliType} input box after ${maxAttempts} attempts for ${sessionName}`);
                throw new Error(`${cliType} did not accept Enter — command left unsent. CLI may still be initializing.`);
            }
            this.logger.error(`Enter may not have been accepted after ${maxAttempts} attempts for ${sessionName}`);
            return preInjectOutput;
        } finally {
            // Clean up temp file
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    // After _injectCommand returns "successfully" (paste landed, Enter sent),
    // verify the CLI actually started a turn. Catches silent input rejection
    // — e.g. Codex at usage limit accepts the bracketed-paste indicator and
    // then drops Enter, leaving an empty prompt that would otherwise sit
    // until the 30-min poller timeout. Throws so the inject-fail fallback in
    // _processCommand can switch to the next CLI in injectChain.
    //
    // Signal we trust: scrollback ABOVE the live TUI grew. Real turn output
    // streams into scrollback; transient banners (usage-limit modal, paste
    // placeholder, "esc to interrupt" flashes) all live in the bottom rows
    // of the pane and don't commit to scrollback. The bottom 10 lines also
    // contain the input box, footer (time/context %), and rotating hint
    // line — too noisy to compare against baseline. Strip them and compare
    // only the upper region.
    async _verifyTurnProgress(sessionName, cliType, baseline, sessionKey = null, injectStartedAt = null, timeoutMs = 90000) {
        const adapter = getCliAdapter(cliType);
        const fatalPatterns = adapter.fatalErrorPatterns || [];
        const excludePatterns = adapter.workingExcludePatterns || [];
        const aboveTui = (text) => {
            const lines = (text || '').split('\n');
            return lines.slice(0, Math.max(0, lines.length - 10))
                .join('\n')
                .replace(/\s+/g, ' ')
                .trim();
        };
        // Mirror of _injectCommand's indicatorHit: is the CLI visibly busy?
        // A long tool-running turn (filing a ticket, auditing many endpoints)
        // can spend >timeoutMs thinking before it commits anything to upper
        // scrollback — the live spinner/timer sits in the bottom TUI rows that
        // aboveTui() strips. Treating that as "silently rejected" is a false
        // alarm: the input WAS accepted, the turn is just slow.
        const isWorking = (text) => {
            const filtered = (text || '')
                .split('\n')
                .filter(l => !excludePatterns.some(re => re.test(l)))
                .join('\n')
                .toLowerCase();
            if (adapter.workingIndicators.some(ind => filtered.includes(ind))) return true;
            return (adapter.workingRegexes || []).some(re => re.test(filtered));
        };
        const baselineUpper = aboveTui(baseline);
        const markerPath = sessionKey ? `/tmp/cli-hook-post-${sessionKey}` : null;
        // UserPromptSubmit marker: cli-hook-notify.js writes this the instant
        // Claude accepts the submitted prompt. It's the strongest "the paste +
        // Enter was accepted and a turn started" signal we have — event-driven,
        // no dependence on TUI rendering — so it short-circuits the brittle
        // scrollback/spinner heuristics entirely. Claude-only (Codex/Gemini
        // have no submit hook), so the heuristics below remain the fallback.
        const promptMarkerPath = sessionKey ? `/tmp/cli-hook-prompt-${sessionKey}` : null;
        const start = Date.now();
        const intervalMs = 2000;
        // Initial settle — paste retries and Enter keystrokes leave the TUI
        // briefly noisy.
        await new Promise(r => setTimeout(r, intervalMs));
        while (true) {
            const output = this._captureOutput(sessionName);
            // Authoritative signal first: the CLI itself prints a fatal error
            // banner (e.g. Codex's "You've hit your usage limit"). When at
            // quota, Codex still echoes the pasted prompt into the pane,
            // which would otherwise look like real scrollback growth and
            // hide the failure.
            const fatal = fatalPatterns.find(p => p.regex.test(output));
            if (fatal) {
                throw new Error(`${cliType} ${fatal.reason}`);
            }
            // Authoritative turn-start: the UserPromptSubmit hook dropped a
            // marker newer than this inject's start, so Claude definitely
            // accepted the prompt. That's exactly what this method exists to
            // confirm — return without touching the TUI heuristics.
            if (promptMarkerPath && injectStartedAt) {
                try {
                    const ts = parseInt(fs.readFileSync(promptMarkerPath, 'utf8'), 10);
                    if (Number.isFinite(ts) && ts >= injectStartedAt) {
                        this.logger.info(`${cliType} prompt-submit marker confirmed turn start for ${sessionName}`);
                        return;
                    }
                } catch { /* no marker yet — fall through to other signals */ }
            }
            // Authoritative success: cli-hook-notify.js drops a marker file
            // when the Stop hook successfully posts the assistant message to
            // Slack. If we see a fresh marker (newer than this inject's
            // start), the turn definitely completed — skip the brittle
            // scrollback-growth heuristic that false-positives when the
            // response is short enough to fit inside the bottom-10 TUI rows.
            if (markerPath && injectStartedAt) {
                try {
                    const ts = parseInt(fs.readFileSync(markerPath, 'utf8'), 10);
                    if (Number.isFinite(ts) && ts >= injectStartedAt) return;
                } catch { /* no marker yet — fall through to scrollback check */ }
            }
            const currentUpper = aboveTui(output);
            if (currentUpper.length > baselineUpper.length + 50 && currentUpper !== baselineUpper) {
                return;
            }
            if (Date.now() - start >= timeoutMs) {
                // Before declaring the input lost, re-capture the pane and look
                // for the adapter's working signal. If the CLI is actively busy
                // (spinner verb / per-turn timer in the bottom rows), the turn
                // is alive and just slow — hand off to the poller instead of
                // posting a misleading "silently rejected, resend" warning that
                // risks a duplicate command landing in the same session.
                const freshOutput = this._captureOutput(sessionName);
                if (isWorking(freshOutput)) {
                    this.logger.info(`${cliType} still working after ${Math.round(timeoutMs / 1000)}s for ${sessionName} — slow turn, deferring to poller`);
                    return;
                }
                throw new Error(`${cliType} accepted the paste but never produced output within ${Math.round(timeoutMs / 1000)}s — input was silently rejected (likely usage limit or dropped Enter)`);
            }
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }

    _captureOutput(sessionName) {
        try {
            return execSync(`tmux capture-pane -t ${sessionName} -p -S -200`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch {
            return '';
        }
    }

    _paneSnapshotPath(sessionKey) {
        return path.join(this._paneSnapshotDir, `${String(sessionKey).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
    }

    // Snapshot the live tmux pane's scrollback to disk so a later recreate —
    // after an inactivity-timeout kill or an external crash — can replay the
    // actual CLI conversation instead of a lossy Slack-thread summary. A dead
    // pane can't be captured, so this MUST run while the session is alive
    // (end of each turn + just before we kill on inactivity timeout).
    // Uses execFileSync (no shell) — sessionName is internally generated, but
    // array args keep it injection-proof regardless.
    _snapshotPaneForResume(sessionName, sessionKey) {
        if (!sessionName || !sessionKey) return;
        try {
            const text = execFileSync('tmux', ['capture-pane', '-t', sessionName, '-p', '-S', '-3000'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                maxBuffer: 8 * 1024 * 1024
            });
            if (!text || !text.trim()) return;
            if (!fs.existsSync(this._paneSnapshotDir)) {
                fs.mkdirSync(this._paneSnapshotDir, { recursive: true });
            }
            fs.writeFileSync(this._paneSnapshotPath(sessionKey), text, 'utf8');
        } catch (err) {
            this.logger.warn(`Pane snapshot failed for ${sessionName}: ${err.message}`);
        }
    }

    // Read back the most recent pane snapshot for replay into a recreated
    // session. Returns the tail only — the recent turns matter most and older
    // scrollback is the least useful, most token-costly part to re-inject.
    _readPaneSnapshot(sessionKey) {
        try {
            const p = this._paneSnapshotPath(sessionKey);
            if (!fs.existsSync(p)) return null;
            let text = fs.readFileSync(p, 'utf8');
            if (!text || !text.trim()) return null;
            const MAX = 24000; // ~6k tokens of recent scrollback
            if (text.length > MAX) text = text.slice(-MAX);
            return text.trim();
        } catch {
            return null;
        }
    }

    _clearPaneSnapshot(sessionKey) {
        try { fs.unlinkSync(this._paneSnapshotPath(sessionKey)); } catch { /* nothing to clear */ }
    }

    // Capture the pane and run the CLI adapter's working-indicator match —
    // the same filtering `_injectCommand` and the poller use. Lets the idle
    // timer distinguish "turn still running, nothing posted yet" from a
    // genuinely idle session before killing tmux.
    // The live tail of the pane (last WORKING_TAIL_LINES rows), used both for
    // working-state detection and as a change signature. Deliberately excludes
    // scrollback so stale frames can't be mistaken for live activity.
    _paneWorkingTail(sessionName) {
        return this._captureOutput(sessionName)
            .split('\n')
            .slice(-WORKING_TAIL_LINES)
            .join('\n');
    }

    // Normalize a pane capture into a fingerprint that ignores everything which
    // animates without representing forward progress: the CLI's own working
    // status line (Claude's rotating "Burrowing…" verb, Codex's spinner,
    // Gemini's "Thinking… (8h 54m)"), block/braille animation glyphs, digit
    // runs (timers, token/percent counters, "… N hidden …"), and whitespace
    // churn. A genuinely-busy-looping pane then yields a STABLE key while a
    // progressing turn changes words and moves the key. Provider-agnostic: the
    // working-status lines are dropped via each adapter's own indicators, so it
    // neutralizes Claude/Codex/Gemini chrome uniformly rather than hard-coding
    // one CLI's glyphs (incident 2026-06-23: Gemini's animated shimmer bar +
    // elapsed timer defeated the old digit-only key and pinned the session open
    // for 9h).
    _stableFingerprint(text, adapter) {
        const indicators = (adapter && adapter.workingIndicators) || [];
        const regexes = (adapter && adapter.workingRegexes) || [];
        return String(text)
            .split('\n')
            .filter(line => {
                const l = line.toLowerCase();
                if (indicators.some(ind => l.includes(ind))) return false;
                if (regexes.some(re => re.test(l))) return false;
                return true;
            })
            .join('\n')
            .replace(/[▀-▟⠀-⣿]+/g, '') // block elements + braille spinners
            .replace(/\d+/g, '#')                          // timers, counters, percentages
            .replace(/\s+/g, ' ')
            .trim();
    }

    _isPaneWorking(sessionName, cliType = 'claude') {
        const adapter = getCliAdapter(cliType || 'claude');
        const excludePatterns = adapter.workingExcludePatterns || [];
        const filtered = this._paneWorkingTail(sessionName)
            .split('\n')
            .filter(l => !excludePatterns.some(re => re.test(l)))
            .join('\n')
            .toLowerCase();
        if (adapter.workingIndicators.some(ind => filtered.includes(ind))) return true;
        return (adapter.workingRegexes || []).some(re => re.test(filtered));
    }

    // ─── Response Polling ────────────────────────────────────────────

    _pollForResponse(session, say, sessionKey = null) {
        const { sessionName, threadTs } = session;
        const pollKey = sessionName;
        const isAlertSession = !!session.alertMessageTs;
        const adapter = getCliAdapter(session.cliType || 'claude');
        this.logger.info(`Poller starting for ${sessionName} (alert=${isAlertSession}, cli=${adapter.type})`);
        let isFirstResponse = isAlertSession; // only true for the very first response of an alert
        let alertBuffer = '';
        let alertAccumulationCount = 0;
        const alertStableThreshold = 8; // 8s stability for alert first response (vs 3s regular)

        if (this.pollers.has(pollKey)) {
            clearInterval(this.pollers.get(pollKey).interval);
        }

        let baselineOutput = this._captureOutput(sessionName);
        let lastOutput = baselineOutput;
        let stableCount = 0;
        let attempts = 0;
        let processing = false;
        let everSawWorking = false; // LAYER 3 — silent-drop detector

        // The assistant "thinking" status is set once at injection time (see
        // _processCommand) with loading_messages, which Slack animates on its
        // own. The poller just clears it on the no-post teardown paths below.
        const clearStatus = () => this._setThreadStatus(session.channelId, threadTs, '');
        // Idle-based timeout: only fire after the CLI has been silent for too
        // long (no working spinner AND no output change). Wall-clock-only
        // timeouts kill actively-progressing sessions — e.g. Gemini 3's
        // multi-minute "Thinking..." steps would lose all progress and
        // requeue from scratch. Keep a wall ceiling as a safety net for
        // genuinely runaway sessions.
        const idleTimeoutMs = this.config.pollerTimeoutMs || 1800000; // default 30 min of silence
        const wallCeilingMs = this.config.pollerMaxWallMs || (idleTimeoutMs * 4); // hard cap, default 2h
        // FIX A — no-progress-while-working detector. A CLI that busy-loops on a
        // failing command (e.g. codex retrying an investigation that hits
        // `aws: profile … could not be found`) keeps its spinner animating, so
        // `isWorking` stays true → `lastActivityAt` resets every tick → the idle
        // timeout never trips and escalation to the next CLI waits the full 2h
        // wall ceiling. Track forward progress via a content fingerprint that
        // ignores the volatile spinner/timer/context-% chrome; if the pane hasn't
        // meaningfully changed for `noProgressMs` while the spinner runs, treat it
        // as a stall and take the same LAYER 6 escalation path as an idle timeout.
        // Alert-only: regular @mention tasks can legitimately run a single silent
        // tool (build/test) for minutes, and LAYER 6 escalation is alert-only anyway.
        const noProgressMs = this.config.pollerNoProgressMs || 360000; // default 6 min
        // FIX C — idle-after-work fast escalation. A CLI that worked, then went
        // idle at its empty input prompt without producing a report is stuck and
        // won't resume on its own — e.g. Gemini's auto-Escape on a `Shell
        // awaiting input` confirmation cancels the turn, so AfterAgent never
        // fires and no report posts; the session then sat at the empty prompt and
        // ran out the full 30-min idle ceiling (incident Q2PE51CTP1TPPT,
        // 2026-06-29). Distinct from FIX A (busy-loop WHILE working) and the idle
        // timeout (no work seen / much longer window). Escalate after a short
        // silence instead. Alert-only, and only once the empty prompt has
        // actually been observed (lastHasPrompt) so a session between silent tool
        // calls isn't fast-killed.
        const idleAfterWorkMs = this.config.pollerIdleAfterWorkMs || 180000; // default 3 min
        const pollerStartedAt = Date.now();
        let lastActivityAt = pollerStartedAt;
        let lastProgressAt = pollerStartedAt; // last tick the pane content (sans spinner chrome) changed
        let lastProgressKey = null;
        let lastIsWorking = false; // working-state from the previous tick (timeout check runs before this tick computes it)
        let lastHasPrompt = false; // FIX C — idle-prompt state from the previous tick (same reason: gate runs first)
        let runtimeFatalReason = null; // FIX B — set when a runtime-fatal pattern is seen in the pane
        // Confirmation auto-approve is checked on EVERY tick, independent of the
        // full-pane `stableCount` gate below. A backgrounded sub-agent's animated
        // spinner ("✻ Waiting for 1 background agent to finish") mutates the pane
        // every tick, so `stableCount` never reaches `stableThreshold` and the
        // old in-gate auto-approve could starve forever, leaving Claude frozen on
        // a "Do you want to proceed?" dialog (which is never relayed to Slack) and
        // never firing its Stop hook. We use a tiny private debounce (the dialog
        // text present for `confirmThreshold` consecutive ticks) plus a cooldown
        // so a single dialog isn't double-approved while the keystrokes land.
        let confirmCount = 0;
        let lastAutoApproveAt = 0;
        const confirmThreshold = 2;   // ticks the dialog must persist before we click
        const autoApproveCooldownMs = 4000;
        // Unsent-paste recovery net (Codex Enter-swallow). If the injector's Enter
        // was dropped, the pasted command sits in the composer unsubmitted: no
        // spinner, no detectable idle prompt, the pane frozen at
        // prompt=false working=false forever (incident 2026-07-21, slack-G2LX-…).
        // When we still see a paste placeholder in the composer with nothing
        // running, re-press Enter to submit it. Debounced + cooled-down like
        // auto-approve so we nudge once, not every tick.
        let pasteStuckCount = 0;
        let lastPasteEnterAt = 0;
        const pasteStuckThreshold = 3;      // ticks an unsent paste must persist before nudging
        const pasteEnterCooldownMs = 6000;  // gap between Enter nudges so keystrokes settle
        const stableThreshold = 3;

        const interval = setInterval(async () => {
            try {
            if (processing) return;

            // Stop if tmux session died
            if (!this._isTmuxSessionAlive(sessionName)) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                clearStatus();
                if (alertBuffer) {
                    this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on tmux death for ${sessionName}`);
                }
                // LAYER 3 — silent-drop notice. If we never saw the CLI enter
                // working state, the input was almost certainly dropped (splash
                // wipe, Enter swallowed, etc.) and no Stop hook will fire.
                // Tell the user instead of failing silent.
                if (!everSawWorking) {
                    this.logger.warn(`Silent input drop detected for ${sessionName} (tmux died, working never observed)`);
                    try {
                        await say({
                            text: `:x: \`${session.cliType || 'cli'}\` never started a turn — your message was likely dropped (splash redraw or Enter swallowed). Please reply again to retry.`,
                            thread_ts: threadTs,
                        });
                    } catch (err) {
                        this.logger.error(`Failed to post silent-drop notice: ${err.message}`);
                    }
                }
                // Swap alert reactions (👀→✅) when tmux dies — only if a report
                // actually reached Slack. A ✅ on an uninvestigated alert reads
                // as "handled"; with no report we keep 👀 so the alert stays
                // visibly unresolved (the thread gets a triage notice instead).
                if (isAlertSession && session.alertMessageTs) {
                    // Re-read session so lastBotTs reflects any post that happened during this turn.
                    // Silent-failure requeue is for the startup-race case only: CLI never started a
                    // turn, no output, no Stop hook. If the pane DID show working at any point,
                    // requeueing won't help (same CLI on the same skill hits the same wall) — let
                    // the item complete and surface a manual-triage notice instead.
                    const fresh = sessionKey ? this._getSession(sessionKey) : null;
                    const lastBotTs = fresh?.lastBotTs ?? session.lastBotTs;
                    if (lastBotTs) {
                        await this._removeReaction(session.channelId, session.alertMessageTs, 'eyes').catch(() => {});
                        await this._addReaction(session.channelId, session.alertMessageTs, 'white_check_mark').catch(() => {});
                    }
                    const silentStartup = !lastBotTs && !everSawWorking;
                    if (!silentStartup && !lastBotTs && everSawWorking) {
                        try {
                            await say({
                                text: `:hourglass: \`${session.cliType || 'cli'}\` started work but did not finish before the session ended — manual triage required.`,
                                thread_ts: threadTs,
                            });
                        } catch (err) {
                            this.logger.error(`Failed to post in-progress-timeout notice: ${err.message}`);
                        }
                    }
                    this._completeQueueItem(session.channelId, session.alertMessageTs, { silent: silentStartup });
                }
                this.logger.info(`Poller stopped: tmux session ${sessionName} is dead`);
                return;
            }

            attempts++;

            const now = Date.now();
            const idleMs = now - lastActivityAt;
            const wallMs = now - pollerStartedAt;
            const noProgressMsElapsed = now - lastProgressAt;
            const hitIdleTimeout = idleMs > idleTimeoutMs;
            const hitWallCeiling = wallMs > wallCeilingMs;
            // FIX A — busy-loop stall: working spinner is up but the pane content
            // (sans timer/context chrome) hasn't changed for noProgressMs. Alert
            // sessions only; lastIsWorking gates out genuinely-idle panes (those
            // belong to the idle timeout, which uses a longer window).
            const hitNoProgress = isAlertSession && lastIsWorking && noProgressMsElapsed > noProgressMs;
            // FIX B — a runtime-fatal pattern (e.g. missing AWS profile) was seen
            // in the pane on a prior tick; the investigation cannot succeed, so
            // escalate immediately instead of waiting out noProgressMs.
            const hitRuntimeFatal = isAlertSession && !!runtimeFatalReason;
            // FIX C — worked, then parked idle at the empty prompt (not working)
            // for longer than idleAfterWorkMs without finishing. See note above.
            const hitIdleAfterWork = isAlertSession && everSawWorking && !lastIsWorking && lastHasPrompt && idleMs > idleAfterWorkMs;

            if (hitIdleTimeout || hitWallCeiling || hitNoProgress || hitRuntimeFatal || hitIdleAfterWork) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                clearStatus();
                const reason = hitRuntimeFatal
                    ? `fatal: ${runtimeFatalReason}`
                    : hitWallCeiling
                        ? `wall ceiling ${Math.round(wallMs / 60000)}min`
                        : hitNoProgress
                            ? `no progress for ${Math.round(noProgressMsElapsed / 60000)}min while working`
                            : hitIdleAfterWork
                                ? `idle at prompt ${Math.round(idleMs / 60000)}min after working (no report)`
                                : `idle ${Math.round(idleMs / 60000)}min`;
                this.logger.warn(`Poller timeout (${reason}) for ${sessionName} (alert=${isAlertSession}, everSawWorking=${everSawWorking})`);
                // LAYER 6 — runtime fallback (set inside the alert branch
                // below). Populated when the CLI's TUI looked ready and the
                // spinner ran, but the hook never produced a valid report
                // before the idle/wall window expired AND the alert chain has
                // more CLIs left to try. Consumed after the existing tmux
                // kill, before the reaction swap / queue completion — so the
                // recursive _processCommand call gets a clean slate.
                let runtimeFallbackContext = null;
                try {
                    if (!everSawWorking && !hitRuntimeFatal) {
                        // LAYER 3 — silent-drop. Polled the full idle window and the
                        // CLI never entered working state. Input was almost certainly
                        // dropped; no Stop hook will fire. Notify the user.
                        // (A runtime-fatal match escalates via the alert branch below
                        // even if the spinner was never seen — the error is real.)
                        this.logger.warn(`Silent input drop detected for ${sessionName} (timeout, working never observed)`);
                        await say({
                            text: `:x: \`${session.cliType || 'cli'}\` never started a turn — your message was likely dropped (splash redraw or Enter swallowed). Please reply again to retry.`,
                            thread_ts: threadTs,
                        });
                    } else if (isAlertSession) {
                        // Worked but never finished. Catches failure modes the
                        // startup fatalErrorPatterns check can't see — e.g.
                        // Gemini API geo-blocked after isReady matched,
                        // mid-session quota exhaustion, an infinite tool-retry
                        // loop. Skipped when a report was already posted
                        // (lastBotTs set) — those are post-success idles.
                        const fresh = sessionKey ? this._getSession(sessionKey) : null;
                        const reportPosted = fresh?.lastBotTs ?? session.lastBotTs ?? null;
                        const chain = Array.isArray(session.injectChain) ? session.injectChain : [];
                        const nextCli = (!reportPosted && chain.length > 1 && session.alertPrompt) ? chain[1] : null;
                        if (nextCli) {
                            runtimeFallbackContext = {
                                channelId: session.channelId,
                                alertMessageTs: session.alertMessageTs,
                                prompt: session.alertPrompt,
                                remainingChain: chain.slice(1),
                                failedCli: session.cliType || 'cli',
                                nextCli,
                            };
                            await say({
                                text: `:repeat: \`${runtimeFallbackContext.failedCli}\` ran ${reason} without producing a report — restarting investigation with \`${nextCli}\`...`,
                                thread_ts: threadTs,
                            });
                            if (alertBuffer) {
                                this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on runtime fallback for ${sessionName}`);
                            }
                        } else if (!reportPosted) {
                            await say({
                                text: `:hourglass: Investigation did not complete (${reason}) — manual triage required.`,
                                thread_ts: threadTs,
                            });
                            if (alertBuffer) {
                                this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on idle timeout for ${sessionName}`);
                            }
                        } else {
                            // Post-success idle: the report already posted (lastBotTs set)
                            // and the CLI just sat idle afterwards until the window
                            // expired. The investigation completed — tearing down here is
                            // expected, so stay silent rather than posting a misleading
                            // "did not complete" triage notice on a finished alert.
                            this.logger.info(`Post-success idle for ${sessionName} (${reason}, report already posted at last_bot_ts=${reportPosted}) — no triage notice`);
                            if (alertBuffer) {
                                this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on post-success idle for ${sessionName}`);
                            }
                        }
                    } else if (alertBuffer) {
                        this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on idle timeout for ${sessionName}`);
                    } else {
                        await say({ text: 'Claude session timed out. Send another message to continue.', thread_ts: threadTs });
                    }
                } catch (err) {
                    this.logger.error(`Failed to send timeout/flush message: ${err.message}`);
                }
                // Kill unresponsive tmux — will be recreated on next user message
                try {
                    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
                    this.logger.info(`Killed tmux session ${sessionName} after poller timeout`);
                } catch (_) { /* already dead */ }
                // Runtime fallback (LAYER 6): if the alert branch above flagged
                // that the chain has more CLIs to try, delete the dead session
                // row and re-trigger _processCommand on the same alert with the
                // remaining chain. Reactions stay (👀 on the PD message), the
                // queue row stays 'processing' — the recursive run re-arms
                // everything when its inject lands, or swaps 👀→❌ via its own
                // start-failure path if every remaining CLI also fails to boot.
                if (runtimeFallbackContext) {
                    if (sessionKey) {
                        this._clearSessionTimeout(sessionKey);
                        this._deleteSession(sessionKey);
                    }
                    const ctx = runtimeFallbackContext;
                    this._processCommand(ctx.channelId, threadTs, ctx.prompt, null, ctx.alertMessageTs, ctx.alertMessageTs, null, ctx.remainingChain)
                        .catch(err => this.logger.error(`Runtime fallback to ${ctx.nextCli} failed to launch: ${err.message}`));
                    return;
                }
                if (sessionKey) {
                    this._clearSessionTimeout(sessionKey);
                    const sess = this._getSession(sessionKey);
                    if (sess?.alertMessageTs) {
                        // ✅ only when a report was actually posted — a no-report
                        // timeout keeps 👀 so the alert stays visibly unresolved.
                        if (sess.lastBotTs) {
                            await this._removeReaction(sess.channelId, sess.alertMessageTs, 'eyes').catch(() => {});
                            await this._addReaction(sess.channelId, sess.alertMessageTs, 'white_check_mark').catch(() => {});
                        }
                        // Requeue only on genuine startup race (no bot post AND
                        // the CLI never entered working state). In-progress timeouts
                        // get silent=false so the queue completes without retry.
                        const silentStartup = !sess.lastBotTs && !everSawWorking;
                        this._completeQueueItem(sess.channelId, sess.alertMessageTs, { silent: silentStartup });
                    }
                }
                return;
            }

            const currentOutput = this._captureOutput(sessionName);

            if (currentOutput === lastOutput) {
                stableCount++;
            } else {
                stableCount = 0;
                lastOutput = currentOutput;
            }

            // Check prompt and working state on every tick (not gated by stableCount).
            // Claude's animated timer ("35s", "36s"...) changes output every second,
            // so stableCount never reaches the threshold. Prompt/stall detection must
            // run independently.
            const lines = currentOutput.trimEnd().split('\n');
            const tailLines = lines.slice(-10);
            // Codex uses `›` (U+203A) instead of `❯` (U+276F) and always renders
            // the input row as `› <placeholder hint>` (e.g. `› Summarize recent
            // commits`), so we must match a leading `› ` line in addition to the
            // bare-prompt forms used by Claude.
            // Adapter-specific idle-prompt patterns let each CLI declare what its
            // empty input row looks like. Gemini renders ` *   Type your message …`
            // (asterisk bullet + placeholder) and none of the shared `❯`/`>`/`›`
            // forms match — see gemini-adapter.js `idlePromptIndicators`.
            const adapterIdleIndicators = adapter.idlePromptIndicators || [];
            const hasPrompt = tailLines.some(l => {
                const trimmed = l.trim();
                if (trimmed === '❯' || trimmed === '>' || trimmed === '›' ||
                    trimmed.match(/^[>❯›]\s*$/) ||
                    trimmed.includes('│ >') || trimmed.includes('│ ❯') ||
                    trimmed.startsWith('› ')) return true;
                return adapterIdleIndicators.some(ind =>
                    typeof ind === 'string' ? l.includes(ind) : ind.test(l)
                );
            });

            // Use a wider window (30 lines) for working detection — Claude Code's
            // working status (e.g. "✽ Burrowing… (54s · ↓ 331 tokens)") can be
            // pushed far above the bottom by separators, prompt, OMC status bar,
            // and queued-message chrome. 10 lines missed it routinely.
            const wideLines = lines.slice(-30);
            // Exclude OMC status bar lines (contain "[OMC#") from isWorking check —
            // the status bar can show stale "thinking" even when Claude is idle.
            // Adapter-specific excludes drop chrome that contains working-verb
            // substrings (e.g. Codex's MCP startup banner has "esc to interrupt").
            const excludePatterns = adapter.workingExcludePatterns || [];
            const nonStatusLines = wideLines.filter(l => {
                if (l.includes('[OMC#')) return false;
                return !excludePatterns.some(re => re.test(l));
            });
            const tailText = nonStatusLines.join(' ').toLowerCase();
            // Working-state detection comes from the adapter so each CLI has its own
            // indicator set (Claude Code rotates verbs like "Burrowing" / "Metamorphosing";
            // Codex uses a different spinner vocabulary).
            const isWorking =
                adapter.workingIndicators.some(ind => tailText.includes(ind)) ||
                (adapter.workingRegexes || []).some(re => re.test(tailText));
            if (isWorking) everSawWorking = true;

            // Confirmation auto-approve — runs on EVERY tick, NOT gated by
            // `stableCount >= stableThreshold`. A blocking CLI confirmation (e.g.
            // Claude Code's bash-safety "Do you want to proceed?", which fires even
            // under --dangerously-skip-permissions) is a terminal state the model
            // can't escape on its own — it's suspended below the harness layer, so
            // the Slack `ask_user` MCP can't reach it either. Animated chrome
            // elsewhere on the pane (a backgrounded sub-agent's spinner) keeps
            // resetting `stableCount`, so the old in-gate check could wait forever.
            // The `confirmThreshold` debounce avoids firing on a transient frame;
            // the cooldown avoids re-clicking while the keystrokes land.
            if (adapter.handlesConfirmationPrompts &&
                !isWorking &&
                (adapter.confirmationPrompts || []).some(p => currentOutput.includes(p))) {
                confirmCount++;
                if (confirmCount >= confirmThreshold &&
                    Date.now() - lastAutoApproveAt >= autoApproveCooldownMs) {
                    this._autoApprove(sessionName, currentOutput);
                    lastAutoApproveAt = Date.now();
                    confirmCount = 0;
                    stableCount = 0;
                }
            } else {
                confirmCount = 0;
            }

            // Unsent-paste recovery — see the pasteStuck* declarations above.
            // Only fires while nothing is running (isWorking false): a live turn
            // never shows the placeholder in the composer, and an idle real prompt
            // has no placeholder, so this matches only a genuinely swallowed Enter.
            // An extra Enter on an already-empty composer is a harmless no-op.
            if (!isWorking && this._pasteStuckInComposer(currentOutput, adapter)) {
                pasteStuckCount++;
                if (pasteStuckCount >= pasteStuckThreshold &&
                    Date.now() - lastPasteEnterAt >= pasteEnterCooldownMs) {
                    this.logger.warn(`Unsent paste detected in composer for ${sessionName} — re-pressing Enter to submit`);
                    try { execSync(`tmux send-keys -t ${sessionName} Enter`); } catch (_) { /* pane gone */ }
                    lastPasteEnterAt = Date.now();
                    pasteStuckCount = 0;
                    stableCount = 0;
                }
            } else {
                pasteStuckCount = 0;
            }

            // FIX A — forward-progress fingerprint. Strip digit runs (the
            // spinner timer "Working (4m 04s)", "Context 20% used", "5h 91% le…",
            // token counters) so a busy-loop reprinting the same error/screen
            // produces a stable key, while a genuinely-progressing investigation
            // changes words and resets the no-progress clock. Read by hitNoProgress
            // on the NEXT tick (the timeout check runs before this block).
            const progressKey = this._stableFingerprint(nonStatusLines.join('\n'), adapter);
            if (progressKey !== lastProgressKey) {
                lastProgressKey = progressKey;
                lastProgressAt = Date.now();
            }
            lastIsWorking = isWorking;
            lastHasPrompt = hasPrompt; // FIX C — read by the idle-after-work gate on the next tick

            // FIX B — runtime-fatal pattern scan. Distinct from startup
            // `fatalErrorPatterns` (checked during readiness polling): these are
            // errors that surface mid-turn and guarantee the investigation can't
            // succeed (e.g. a missing AWS profile fails every query). On match,
            // record the reason; the timeout gate escalates to the next CLI (or
            // posts the manual-triage notice) on the next tick. Latched — once
            // fatal, stay fatal even if the line scrolls off.
            if (!runtimeFatalReason && Array.isArray(adapter.runtimeFatalPatterns)) {
                for (const pat of adapter.runtimeFatalPatterns) {
                    if (pat.regex.test(currentOutput)) {
                        runtimeFatalReason = pat.reason;
                        this.logger.warn(`Runtime-fatal pattern matched for ${sessionName} (cli=${session.cliType}): ${pat.reason}`);
                        break;
                    }
                }
            }

            // Activity tracking for the idle-based timeout. Output change OR
            // an active spinner both count — a CLI mid-inference may keep the
            // pane visually identical for many seconds (Gemini's "Thinking..."
            // timer increments but the screen capture can occasionally match
            // depending on tmux refresh), so we need both signals.
            if (isWorking || stableCount === 0) {
                lastActivityAt = Date.now();
            }
            // Session-inactivity timer is anchored to `last_bot_ts` inside
            // `_startSessionTimeout` (it reschedules itself when it fires and
            // sees a recent bot post), so the poller no longer needs to
            // re-arm it during working windows. The old re-arm here missed
            // long silent tool calls (Athena queries) where neither
            // `isWorking` nor `stableCount === 0` held for many minutes.

            if (attempts % 10 === 0) {
                const lastFiveLines = lines.slice(-5).map(l => l.trim()).join(' | ');
                this.logger.info(`Poll #${attempts} | stable=${stableCount} prompt=${hasPrompt} working=${isWorking} | ${lastFiveLines.substring(0, 120)}`);
            }

            if (stableCount >= (isAlertSession && isFirstResponse ? alertStableThreshold : stableThreshold)) {

                if (hasPrompt && !isWorking) {
                    // Skip extraction if output hasn't changed since last baseline reset
                    if (baselineOutput === currentOutput) {
                        stableCount = 0;
                        return;
                    }

                    const response = this._extractResponse(baselineOutput, currentOutput);

                    if (!response && isAlertSession) {
                        this.logger.warn(`Alert extraction returned empty for ${sessionName} (baseline=${baselineOutput.length} chars, current=${currentOutput.length} chars)`);
                    }

                    if (response) {
                        // Alert first response: accumulate until completion marker or fallback
                        if (isAlertSession && isFirstResponse) {
                            alertBuffer += (alertBuffer ? '\n' : '') + response;
                            alertAccumulationCount++;

                            // Use stricter marker detection to avoid matching intermediate narration
                            // (e.g. "Recommended Action: Investigation directory created...").
                            // Real reports use markdown headings (## Recommended Action) or bold (**Recommended Action:**)
                            // and are substantially longer than one-line status messages.
                            const MIN_ALERT_BUFFER_LEN = 500;
                            const hasCompletionMarker = alertBuffer.length >= MIN_ALERT_BUFFER_LEN
                                && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:?/im.test(alertBuffer);

                            if (hasCompletionMarker || alertAccumulationCount >= 5) {
                                // Stop the accumulation loop. Posting is normally handled by
                                // cli-hook-notify.js (Stop / AfterAgent / Codex notify) which
                                // reads the clean transcript. The watchdog below verifies the
                                // hook actually fires — if it doesn't (CLI stuck on a tool prompt,
                                // crash, OOM), we fall back to posting the accumulated buffer so
                                // the investigation isn't silently dropped.
                                const reason = hasCompletionMarker ? 'completion marker found' : `fallback after ${alertAccumulationCount} cycles`;
                                this.logger.info(`Alert poller done (${reason}): ${alertBuffer.length} chars for ${sessionName} — arming hook watchdog`);
                                isFirstResponse = false;
                                clearInterval(interval);
                                this.pollers.delete(pollKey);
                                if (session.alertMessageTs) {
                                    // Free the queue slot immediately so the next alert can start.
                                    // Reaction swap is deferred to the watchdog so 👀 → ✅ only flips
                                    // once content actually lands in the thread.
                                    this._completeQueueItem(session.channelId, session.alertMessageTs);
                                    this._armHookWatchdog({
                                        sessionKey,
                                        sessionName,
                                        channelId: session.channelId,
                                        threadTs,
                                        alertMessageTs: session.alertMessageTs,
                                        buffer: alertBuffer,
                                        cliType: session.cliType,
                                        // Completion-marker path trusts the hook more; fallback path
                                        // is more likely to need partial-post rescue.
                                        timeoutMs: hasCompletionMarker ? 90000 : 60000,
                                    });
                                }
                                return;
                            } else {
                                this.logger.info(`Alert accumulating cycle ${alertAccumulationCount} (${alertBuffer.length} chars) for ${sessionName}, waiting for completion marker`);
                            }

                            // Always reset baseline so next diff is incremental
                            baselineOutput = currentOutput;
                            lastOutput = currentOutput;
                            stableCount = 0;
                            attempts = 0;
                            return;
                        }

                        // Regular session or subsequent alert responses
                        processing = true;
                        try {
                            // Gemini's tmux footer doesn't carry parseable Ctx/In/Out
                            // figures; product convention is to show the model only
                            // ("Auto (Gemini 3)"). For Claude/Codex we still parse
                            // the footer line — same call site, different source.
                            const sessionStats = adapter.type === 'gemini'
                                ? { model: 'Auto (Gemini 3)' }
                                : this._extractSessionStats(currentOutput);
                            this.logger.info(`Response extracted (${response.length} chars): "${response.substring(0, 200)}"`);

                            await this._sendResponse(say, threadTs, response, sessionStats);
                            this.logger.info(`Response sent to Slack thread ${threadTs}`);
                            // Answer landed — drop the thinking shimmer. (Slack
                            // also auto-clears status on an app message, but be
                            // explicit so a later working window can re-arm it.)
                            clearStatus();

                            // Track last bot response timestamp for thread context
                            if (sessionKey) {
                                const nowTs = String(Date.now() / 1000);
                                this._updateLastBotTs(sessionKey, nowTs);
                                this._startSessionTimeout(sessionKey);
                                // End of a completed turn — the pane now holds the
                                // fullest context. Snapshot it so a later crash or
                                // inactivity kill can replay it on recreate.
                                this._snapshotPaneForResume(sessionName, sessionKey);
                            }
                        } catch (err) {
                            this.logger.error(`Failed to send response to Slack: ${err.message}`);
                        } finally {
                            processing = false;
                        }
                    }

                    // Reset baseline and continue polling for local terminal input
                    baselineOutput = currentOutput;
                    lastOutput = currentOutput;
                    stableCount = 0;
                    attempts = 0;
                    return;
                }

                // (Confirmation auto-approve moved out of this stability gate —
                // see the per-tick block above, after `isWorking` is computed.)
            }
            } catch (err) {
                this.logger.error(`Poller error for ${sessionName}: ${err.message}`);
            }
        }, 1000);

        this.pollers.set(pollKey, { interval, session });
    }

    _startSessionTimeout(sessionKey, delayOverrideMs = null) {
        // Clear any existing timer
        if (this.sessionTimers.has(sessionKey)) {
            clearTimeout(this.sessionTimers.get(sessionKey));
        }

        const session = this._getSession(sessionKey);
        const isAlert = !!session?.alertMessageTs;
        const defaultTimeout = isAlert ? (this.config.pollerTimeoutMs || 1800000) : 300000; // 30min for alerts (matches poller), 5min for regular
        const configTimeout = this.config.sessionInactivityTimeoutMs;
        // For alerts, use the longer default unless config explicitly exceeds it
        const timeoutMs = isAlert ? Math.max(configTimeout || 0, defaultTimeout) : (configTimeout || defaultTimeout);

        // Anchor the delay to `last_bot_ts` so the countdown is measured from
        // the bot's most recent reply, not from whenever this function was
        // called. Without this anchor, an arming during user-message intake
        // (or an inherited timer from session reconciliation) can race ahead
        // of a long-running response and fire moments after the bot finally
        // posts — see thread C08S954G2LX/p1779784228361329 where a 16-min
        // Athena query was followed by a "15min inactivity" notice 37s later.
        const lastBotMs = this._parseBotTsMs(session?.lastBotTs);
        let delayMs = timeoutMs;
        if (delayOverrideMs != null) {
            delayMs = delayOverrideMs;
        } else if (lastBotMs) {
            delayMs = Math.max(0, (lastBotMs + timeoutMs) - Date.now());
        }
        const timer = setTimeout(async () => {
            const session = this._getSession(sessionKey);
            if (!session) {
                this.sessionTimers.delete(sessionKey);
                return;
            }

            // Re-check `last_bot_ts` at fire time. `cli-hook-notify.js` posts
            // regular @mention responses from a separate process and updates
            // `last_bot_ts` in SQLite — it can't reach our in-memory timer
            // map. If a fresh bot post landed while we were sleeping, the
            // user's inactivity window restarts from that post; reschedule
            // for the remaining time instead of timing out.
            const freshBotMs = this._parseBotTsMs(session.lastBotTs);
            if (freshBotMs && Date.now() - freshBotMs < timeoutMs) {
                this.sessionTimers.delete(sessionKey);
                this._midTurnRechecks.delete(sessionKey);
                this._startSessionTimeout(sessionKey);
                return;
            }

            // `last_bot_ts` only sees Slack-side activity — a turn that is
            // still mid-flight has posted nothing yet. That's routine after a
            // service restart (KillMode=process): the tmux session survived
            // with a turn in progress, reconciliation re-armed this timer, but
            // no poller is watching the pane. Killing on staleness alone would
            // execute the session mid-turn; check the pane's live working
            // indicators and re-check soon instead.
            if (this._isPaneWorking(session.sessionName, session.cliType)) {
                // Absolute wall cap — independent of any working-indicator
                // heuristic. A single turn cannot stay in flight forever; this
                // survives service restarts (KillMode=process kills the
                // in-memory poller, but this timer is re-armed by reconcile and
                // anchored to DB timestamps). Without it, a pane whose chrome
                // keeps mutating resets the recheck signature every cycle and
                // never tears down (incident 2026-06-23: a Gemini alert turn
                // looped on ExpiredTokenException for 9h). Anchored to the most
                // recent of session creation / last bot post so an actively
                // replying chat session never trips it.
                const turnAnchorMs = Math.max(
                    session.createdAt || 0,
                    this._parseBotTsMs(session.lastBotTs) || 0
                );
                const maxTurnWallMs = this.config.maxTurnWallMs || 7200000; // 2h
                if (turnAnchorMs && (Date.now() - turnAnchorMs) > maxTurnWallMs) {
                    this.logger.warn(`Session ${session.sessionName} exceeded ${Math.round(maxTurnWallMs / 60000)}min turn wall cap while working — tearing down`);
                    this._midTurnRechecks.delete(sessionKey);
                    // fall through to teardown
                } else {
                    // The working indicator might be a STALE frame, not a live turn.
                    // A genuine turn mutates the live tail every second (token timer,
                    // spinner); a stuck/finished one is byte-identical between
                    // rechecks. Track a NORMALIZED tail signature (animated
                    // spinner/timer/glyph chrome stripped) so a busy-loop reprinting
                    // the same screen sits unchanged and counts down, instead of the
                    // raw tail whose chrome churn reset the count forever. Once it
                    // holds across MAX_MIDTURN_RECHECKS rechecks, tear down.
                    const sig = this._stableFingerprint(
                        this._paneWorkingTail(session.sessionName),
                        getCliAdapter(session.cliType)
                    );
                    const prev = this._midTurnRechecks.get(sessionKey);
                    if (prev && prev.sig === sig) {
                        prev.count += 1;
                    } else {
                        this._midTurnRechecks.set(sessionKey, { sig, count: 1 });
                    }
                    const { count } = this._midTurnRechecks.get(sessionKey);
                    if (count < MAX_MIDTURN_RECHECKS) {
                        this.logger.info(`Session ${session.sessionName} idle timer fired mid-turn — pane still working (recheck ${count}/${MAX_MIDTURN_RECHECKS}), rechecking in 5min`);
                        this.sessionTimers.delete(sessionKey);
                        this._startSessionTimeout(sessionKey, Math.min(timeoutMs, 300000));
                        return;
                    }
                    this.logger.warn(`Session ${session.sessionName} 'working' indicator unchanged across ${count} rechecks — treating as stale, tearing down`);
                    this._midTurnRechecks.delete(sessionKey);
                    // fall through to teardown
                }
            }
            this._midTurnRechecks.delete(sessionKey);

            const minutes = Math.round(timeoutMs / 60000);
            this.logger.info(`Session ${session.sessionName} timed out after ${minutes}min of inactivity`);

            // Capture the pane while it's still alive — once we kill it the
            // scrollback is gone, and the next @mention would otherwise
            // recreate a blank session with no prior context.
            this._snapshotPaneForResume(session.sessionName, sessionKey);

            // Kill tmux session
            try {
                execSync(`tmux kill-session -t ${session.sessionName} 2>/dev/null`);
            } catch (_) { /* already dead */ }

            // Stop poller
            if (this.pollers.has(session.sessionName)) {
                clearInterval(this.pollers.get(session.sessionName).interval);
                this.pollers.delete(session.sessionName);
            }

            // Drop any lingering thinking shimmer — the quiet ✅ timeout path
            // posts no message, so Slack won't auto-clear the status for us.
            this._setThreadStatus(session.channelId, session.threadTs, '');

            // Notify user/channel about session timeout
            try {
                const isAlertWithUserChat = session.alertMessageTs && session.lastUserId;

                if (session.alertMessageTs) {
                    // Alert session: swap reactions
                    await this._removeReaction(session.channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(session.channelId, session.alertMessageTs, 'white_check_mark');
                    // Inactivity timeout for an alert that's still in 'processing' state means
                    // the completion-marker path never ran. Hand silent=true; _completeQueueItem
                    // gates the requeue on the queue item still being 'processing', so completed
                    // items are no-op'd.
                    this._completeQueueItem(session.channelId, session.alertMessageTs, { silent: true });
                }

                if (!session.alertMessageTs || isAlertWithUserChat) {
                    // Regular session or alert+user hybrid: mark the timeout quietly
                    // with a ✅ reaction on the bot's latest reply instead of pinging
                    // the user with a new message.
                    if (session.lastBotTs) {
                        await this._addReaction(session.channelId, session.lastBotTs, 'white_check_mark');
                    } else {
                        // No bot reply to react to — fall back to a non-mention notice.
                        await this.app.client.chat.postMessage({
                            channel: session.channelId,
                            text: `Session timed out after ${minutes}min of inactivity. Send a message to resume.`,
                            thread_ts: session.threadTs
                        });
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to send timeout notice: ${err.message}`);
            }

            // Keep DB record — repo_path and alert_message_ts preserved for session resumption.
            // Stale entries are cleaned up by the 7-day startup cleanup.
            this.sessionTimers.delete(sessionKey);
        }, delayMs);

        this.sessionTimers.set(sessionKey, timer);
    }

    // Slack timestamps are "seconds.microseconds" strings (e.g. "1779784191.636949").
    // Convert to ms for arithmetic with Date.now(). Returns null on parse failure
    // so callers can fall back to "no anchor" behavior cleanly.
    _parseBotTsMs(ts) {
        if (!ts) return null;
        const f = parseFloat(ts);
        if (!Number.isFinite(f) || f <= 0) return null;
        return Math.floor(f * 1000);
    }

    _clearSessionTimeout(sessionKey) {
        // The inflight watchdog and the idle timer share a lifecycle: both are
        // cancelled when the user re-engages, /exits, or the session dies.
        this._clearInflightWatchdog(sessionKey);
        this._midTurnRechecks.delete(sessionKey);
        if (this.sessionTimers.has(sessionKey)) {
            clearTimeout(this.sessionTimers.get(sessionKey));
            this.sessionTimers.delete(sessionKey);
        }
    }

    /**
     * Watchdog for regular @mention sessions, where the reply is delivered only
     * by the CLI's Stop hook (cli-hook-notify.js updates `last_bot_ts` when it
     * posts). If no reply lands after injecting:
     *   - heartbeat (default 5min): one ":hourglass: still working" ping so the
     *     thread knows the agent is alive on a long task.
     *   - give-up (>= 10min, anchored to the inject): a "re-send to retry" notice
     *     — distinguishing a stuck-but-alive agent from one killed mid-task.
     * Never kills tmux or deletes the row; cleanup stays with the idle timer,
     * reconcile, and the orphan sweep. Both timers no-op once a reply has landed.
     */
    // `cycle` counts consecutive give-ups where the pane still looked busy and
    // we re-armed instead of warning. Bounded so a *persistent* working-
    // indicator false positive (e.g. a transcript line matching the adapter's
    // workingIndicators that never clears) can't keep the session immortal —
    // after MAX_WORKING_REARMS cycles we warn and hand off to the idle timer
    // regardless.
    _startInflightWatchdog(sessionKey, cycle = 0) {
        const MAX_WORKING_REARMS = 3;
        this._clearInflightWatchdog(sessionKey);
        const injectedAt = Date.now();
        const heartbeatMs = this.config.inflightHeartbeatMs || 300000;
        const giveupMs = Math.max(this.config.sessionInactivityTimeoutMs || 300000, 600000);

        const repliedSinceInject = () => {
            const s = this._getSession(sessionKey);
            if (!s) return true; // session gone — nothing to watch
            const botMs = this._parseBotTsMs(s.lastBotTs);
            return !!(botMs && botMs >= injectedAt);
        };

        const heartbeat = setTimeout(async () => {
            const s = this._getSession(sessionKey);
            if (!s || repliedSinceInject()) return;
            if (!this._isTmuxSessionAlive(s.sessionName)) return; // give-up handles dead sessions
            // Only reassure "still working" when the pane actually shows work.
            // If the CLI isn't visibly working, claiming it is would be the
            // inverse false positive — let the give-up timer assess instead.
            if (!this._isPaneWorking(s.sessionName, s.cliType)) return;
            try {
                await this.app.client.chat.postMessage({
                    channel: s.channelId,
                    thread_ts: s.threadTs,
                    text: ':hourglass_flowing_sand: Still working on it…',
                });
            } catch (err) {
                this.logger.warn(`Inflight heartbeat post failed for ${s.sessionName}: ${err.message}`);
            }
        }, heartbeatMs);

        const giveup = setTimeout(async () => {
            // The watchdog has done its job — hand the session's lifecycle to the
            // idle timer (which tears it down on real inactivity, with a
            // working-pane recheck) and drop the watchdog entry.
            //
            // Previously this left a permanent {spent:true} tombstone instead of
            // deleting, the idea being the hourly sweep would then keep treating
            // the session as watchdog-managed and not arm a second idle-timeout
            // notice. But the sweep treats ANY _inflightWatchdogs entry as
            // managed and never arms an idle timer for it — and this give-up runs
            // for EVERY regular @mention session (answered or stuck) since the
            // tombstone is written before the repliedSinceInject() check below.
            // The result was that every regular session became immortal: no idle
            // timeout was ever armed and the tmux session lived until the next
            // restart. Arm the idle timer here instead.
            const wd = this._inflightWatchdogs.get(sessionKey);
            if (wd && wd.heartbeat) clearTimeout(wd.heartbeat);
            this._inflightWatchdogs.delete(sessionKey);
            const s = this._getSession(sessionKey);
            if (!s || repliedSinceInject()) {
                if (s) this._startSessionTimeout(sessionKey);
                return;
            }
            const alive = this._isTmuxSessionAlive(s.sessionName);
            // If the turn is visibly still running (spinner/working indicators
            // in the pane) it hasn't stalled — it just hasn't posted yet. Don't
            // cry "stuck": re-arm another watchdog cycle and keep watching. A
            // genuinely hung turn stops showing working indicators, so the next
            // cycle (or the idle timer it arms) catches it. This avoids the
            // false-positive warning when Claude is mid-run for >15min.
            if (alive && cycle < MAX_WORKING_REARMS && this._isPaneWorking(s.sessionName, s.cliType)) {
                this.logger.info(`Inflight watchdog: ${s.sessionName} still working, re-arming (cycle ${cycle + 1}/${MAX_WORKING_REARMS})`);
                this._startInflightWatchdog(sessionKey, cycle + 1);
                return;
            }
            // Not working (or dead): hand lifecycle to the idle timer and warn.
            this._startSessionTimeout(sessionKey);
            const mention = s.lastUserId ? `<@${s.lastUserId}> ` : '';
            const minutes = Math.round(giveupMs / 60000);
            const text = alive
                ? `${mention}:warning: No response after ${minutes}min — the agent may be stuck. Re-send your message to retry.`
                : `${mention}:warning: The agent was interrupted before it finished — re-send your message to retry.`;
            try {
                await this.app.client.chat.postMessage({ channel: s.channelId, thread_ts: s.threadTs, text });
            } catch (err) {
                this.logger.warn(`Inflight give-up post failed for ${s.sessionName}: ${err.message}`);
            }
        }, giveupMs);

        this._inflightWatchdogs.set(sessionKey, { heartbeat, giveup });
    }

    _clearInflightWatchdog(sessionKey) {
        const wd = this._inflightWatchdogs.get(sessionKey);
        if (wd) {
            clearTimeout(wd.heartbeat);
            clearTimeout(wd.giveup);
            this._inflightWatchdogs.delete(sessionKey);
        }
    }

    _startSessionSweep() {
        const SWEEP_INTERVAL = 60 * 60 * 1000; // 1 hour
        this._sweepInterval = setInterval(() => {
            const sessions = this._getAllSessions();
            let orphaned = 0;
            let dead = 0;
            for (const s of sessions) {
                if (this._isTmuxSessionAlive(s.sessionName)) {
                    // A live alert poller already owns this session's lifecycle
                    // (idle/wall-ceiling timeouts + teardown). Arming a second,
                    // independent inactivity timer here races the poller: anchored
                    // to a NULL last_bot_ts it counts a flat 30min from sweep time
                    // and ignores poller working-activity, so it can tear an active
                    // investigation down seconds after the agent finally finishes.
                    // Only adopt sessions that are genuinely unmanaged.
                    if (!this.sessionTimers.has(s.sessionKey) && !this.pollers.has(s.sessionName) && !this._inflightWatchdogs.has(s.sessionKey)) {
                        this._startSessionTimeout(s.sessionKey);
                        orphaned++;
                        this.logger.info(`Sweep: started timeout for orphaned session ${s.sessionName}`);
                    }
                } else {
                    if (s.alertMessageTs) {
                        this._removeReaction(s.channelId, s.alertMessageTs, 'eyes').catch(() => {});
                        this._addReaction(s.channelId, s.alertMessageTs, 'white_check_mark').catch(() => {});
                    }
                    this._deleteSession(s.sessionKey);
                    this._clearSessionTimeout(s.sessionKey);
                    dead++;
                }
            }
            if (orphaned > 0 || dead > 0) {
                this.logger.info(`Session sweep: ${orphaned} orphaned timers started, ${dead} dead sessions cleaned`);
            }
        }, SWEEP_INTERVAL);
    }

    /**
     * Stall monitor — scans all live sessions every N seconds for adapter-defined
     * stall patterns (e.g. Claude's "Context limit reached · /compact or /clear").
     * When matched, pings the owner in the session's thread so they can unblock.
     *
     * Runs for ALL sessions (regular + alert). The in-turn poller in
     * `_pollForResponse` only runs for alert sessions and only while Claude's
     * turn is active — a context-limit stall happens when the turn is frozen,
     * so neither that poller nor the Stop hook fire. This monitor is the single
     * source of truth for stall detection.
     */
    _startStallMonitor() {
        const INTERVAL_MS = 15 * 1000; // 15s — fast enough to alert early, slow enough not to thrash
        this._stallState = this._stallState || new Map(); // sessionKey -> { notified: boolean, reason: string }

        this._stallMonitorInterval = setInterval(async () => {
            let sessions;
            try {
                sessions = this._getAllSessions();
            } catch (err) {
                this.logger.error(`Stall monitor: failed to list sessions: ${err.message}`);
                return;
            }

            for (const s of sessions) {
                try {
                    if (!this._isTmuxSessionAlive(s.sessionName)) {
                        this._stallState.delete(s.sessionKey);
                        continue;
                    }
                    const adapter = getCliAdapter(s.cliType || 'claude');
                    const patterns = adapter.stalledPatterns || [];
                    if (patterns.length === 0) continue;

                    const output = this._captureOutput(s.sessionName);
                    const allLines = output.split('\n');
                    const match = patterns.find(p => {
                        // liveTailLines: scan only the bottom N lines so an
                        // already-resolved error sitting in scrollback can't
                        // trigger a false stall (e.g. a 401 followed by a
                        // successful /login further down the pane).
                        const hay = p.liveTailLines
                            ? allLines.slice(-p.liveTailLines).join('\n')
                            : output;
                        if (!p.regex.test(hay)) return false;
                        // clearedRegex: the stall is resolved if its recovery
                        // marker is present in the same region.
                        if (p.clearedRegex && p.clearedRegex.test(hay)) return false;
                        return true;
                    });
                    const state = this._stallState.get(s.sessionKey) || { notified: false };

                    if (match && !state.notified) {
                        this._stallState.set(s.sessionKey, { notified: true, reason: match.reason });
                        this.logger.warn(`Stall detected (${match.reason}) on ${s.sessionName} — notifying thread ${s.threadTs}`);
                        const ownerId = this.config.ownerUserId;
                        const mention = ownerId ? `<@${ownerId}> ` : '';
                        const text = `${mention}:warning: ${match.hint || `${adapter.type} is stalled and needs input to continue.`}`;
                        try {
                            await this.app.client.chat.postMessage({
                                channel: s.channelId,
                                text,
                                thread_ts: s.threadTs,
                            });
                        } catch (err) {
                            this.logger.error(`Stall monitor: failed to post notice for ${s.sessionName}: ${err.message}`);
                            // Don't keep notified=true if the post failed — allow retry next tick
                            this._stallState.set(s.sessionKey, { notified: false });
                        }
                    } else if (!match && state.notified) {
                        this._stallState.set(s.sessionKey, { notified: false });
                        this.logger.info(`Stall cleared on ${s.sessionName} — re-armed`);
                    }
                } catch (err) {
                    this.logger.error(`Stall monitor: error checking ${s.sessionName}: ${err.message}`);
                }
            }
        }, INTERVAL_MS);
    }

    /**
     * After startup, scan recent messages in all relevant channels for @mentions
     * that the bot never replied to. Replays them as if they just arrived.
     * Covers events dropped during restart / Socket Mode reconnection.
     */
    async _replayMissedMentions() {
        const LOOKBACK_S = 300; // 5 minutes
        const oldest = String((Date.now() / 1000) - LOOKBACK_S);

        // Resolve bot user ID
        if (!this._botUserId) {
            try {
                this._botUserId = (await this.app.client.auth.test()).user_id;
            } catch { return; }
        }
        const botId = this._botUserId;

        // Collect channels to scan: main channel + monitor channels
        const channels = new Set();
        if (this.config.channelId) channels.add(this.config.channelId);
        for (const ch of this.alertMonitor.monitoredChannelIds || []) channels.add(ch);

        let replayed = 0;

        for (const channelId of channels) {
            try {
                // Fetch recent channel messages
                const result = await this.app.client.conversations.history({
                    channel: channelId,
                    oldest,
                    limit: 50
                });

                // Collect thread_ts values that have bot mentions
                const threadsToCheck = new Set();
                for (const msg of result.messages || []) {
                    // Top-level @mention
                    if (msg.text?.includes(`<@${botId}>`) && !msg.bot_id && msg.user) {
                        threadsToCheck.add(msg.ts);
                    }
                    // Thread reply that bubbled up — check the thread
                    if (msg.reply_count > 0 && msg.latest_reply) {
                        threadsToCheck.add(msg.ts);
                    }
                }

                for (const threadTs of threadsToCheck) {
                    try {
                        const replies = await this.app.client.conversations.replies({
                            channel: channelId,
                            ts: threadTs,
                            oldest,
                            limit: 50
                        });

                        const messages = replies.messages || [];
                        // Find the last @mention of the bot from a human user
                        let lastMention = null;
                        for (const msg of messages) {
                            if (msg.text?.includes(`<@${botId}>`) && !msg.bot_id && msg.user) {
                                lastMention = msg;
                            }
                        }
                        if (!lastMention) continue;

                        // Check if bot replied after this mention
                        const botRepliedAfter = messages.some(msg =>
                            (msg.bot_id || msg.user === botId) &&
                            parseFloat(msg.ts) > parseFloat(lastMention.ts)
                        );
                        if (botRepliedAfter) continue;

                        // A mention that arrived DURING the boot window is
                        // usually already being handled by the live listener
                        // — its session row lands in the DB before the replay
                        // sweep runs. Replaying it would double-process the
                        // same message (second tmux boot on the same thread).
                        const replaySessionKey = `${channelId}-${threadTs}`;
                        const inFlight = this._getSession(replaySessionKey);
                        if (inFlight && inFlight.updatedAt && parseFloat(lastMention.ts) * 1000 <= inFlight.updatedAt) {
                            continue;
                        }

                        // Live Socket Mode handlers mark timestamps before
                        // doing slow work like booting a Codex tmux session.
                        // During startup, replay can run before that slow path
                        // has saved a session row, so the DB in-flight check
                        // above is not enough. Reuse the same in-memory guard
                        // to avoid replaying a mention already being handled.
                        if (!this._handledMentionTs) this._handledMentionTs = new Set();
                        if (this._handledMentionTs.has(lastMention.ts)) continue;
                        this._handledMentionTs.add(lastMention.ts);
                        if (this._handledMentionTs.size > 200) {
                            const arr = [...this._handledMentionTs];
                            this._handledMentionTs = new Set(arr.slice(-100));
                        }

                        // Missed mention — replay it
                        this.logger.info(`Replaying missed mention: user=${lastMention.user} channel=${channelId} thread=${threadTs} ts=${lastMention.ts}`);
                        const say = async (msgObj) => {
                            await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msgObj });
                        };
                        // conversations.replies messages carry no `channel`
                        // field (unlike live app_mention events) — without
                        // this, session-name derivation downstream does
                        // `undefined.slice(-4)` and the replay crashes with
                        // "Cannot read properties of undefined" in the thread.
                        await this._handleMention({ ...lastMention, channel: channelId }, say);
                        replayed++;
                    } catch (err) {
                        this.logger.warn(`Failed to check thread ${threadTs} in ${channelId}: ${err.message}`);
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to scan channel ${channelId} for missed mentions: ${err.message}`);
            }
        }

        this.logger.info(`[startup] replayMissedMentions: ${replayed} replayed`);
    }

    _extractResponse(baselineOutput, currentOutput) {
        const baseLines = baselineOutput.split('\n');
        const currentLines = currentOutput.split('\n');

        let newLines;
        const bufferScrolled = baseLines.length > 0 && currentLines.length > 0 && baseLines[0] !== currentLines[0];

        if (!bufferScrolled) {
            // Top-down diff: reliable when buffer hasn't scrolled (first lines match).
            let diffStart = 0;
            for (let i = 0; i < Math.min(baseLines.length, currentLines.length); i++) {
                if (baseLines[i] !== currentLines[i]) {
                    diffStart = i;
                    break;
                }
                diffStart = i + 1;
            }

            if (diffStart < baseLines.length) {
                newLines = currentLines.slice(diffStart);
            } else if (currentLines.length > baseLines.length) {
                newLines = currentLines.slice(baseLines.length);
            } else {
                newLines = []; // Identical output
            }
        } else {
            // Buffer scrolled — use anchor-based diff.
            // Find the last occurrence of baseline's tail in current output.
            let baseTrimEnd = baseLines.length;
            while (baseTrimEnd > 0 && baseLines[baseTrimEnd - 1].trim() === '') baseTrimEnd--;
            const trimmedBaseLines = baseLines.slice(0, baseTrimEnd);

            const anchorSize = Math.min(5, trimmedBaseLines.length);
            const baselineTail = trimmedBaseLines.slice(-anchorSize);

            let anchorEnd = -1;
            for (let i = 0; i <= currentLines.length - anchorSize; i++) {
                let match = true;
                for (let j = 0; j < anchorSize; j++) {
                    if (currentLines[i + j] !== baselineTail[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    anchorEnd = i + anchorSize;
                }
            }

            if (anchorEnd >= 0) {
                newLines = currentLines.slice(anchorEnd);
            } else {
                // Anchor completely scrolled out of buffer — use entire buffer as response.
                // This happens when Claude's output exceeds the 200-line tmux capture window.
                this.logger?.info?.(`Anchor lost (buffer scrolled past baseline) — using full buffer (${currentLines.length} lines)`);
                newLines = currentLines;
            }
        }
        const responseLines = newLines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            // Drop the input-box / prompt row entirely. Bare prompts (`>`, `❯`,
            // `›`) are easy, but Claude's TUI also pre-fills the input box with
            // a "next-action" suggestion (e.g. `❯ switch to main`) after a
            // response. Without filtering those, the suggestion text leaks into
            // the Slack post as if it were part of the assistant's reply.
            // The filter here intentionally does NOT match bare `>` followed
            // by content because Claude's responses can use `> ` for markdown
            // blockquotes — only `❯` and `›` are reserved as TUI input prompts.
            if (trimmed === '>' || trimmed === '❯' || trimmed === '›') return false;
            if (trimmed.match(/^[❯›](?:\s|$)/)) return false;
            // Filter Claude CLI chrome/status bar lines
            if (trimmed.match(/^[─━═▪▐▛▜▝▘]+/) || trimmed.match(/^[─━═▪]+$/)) return false;
            if (trimmed.startsWith('Model:') || trimmed.includes('bypass permissions')) return false;
            if (trimmed.match(/^⏵/) && trimmed.includes('permissions')) return false;
            if (trimmed.match(/Ctx\(u\):/) || trimmed.match(/Cost: \$/)) return false;
            return true;
        });

        return responseLines.join('\n').trim();
    }

    /**
     * Build the italicized stats footer line, omitting any field the extractor
     * didn't populate. Gemini sessions return only `model` ("Auto (Gemini 3)"),
     * so the footer collapses to that single label; Claude/Codex still render
     * the full "<model> · Ctx · In · Out" form.
     */
    _formatStatsLine(stats) {
        if (!stats) return '';
        const parts = [];
        if (stats.model) parts.push(stats.model);
        if (stats.context) parts.push(`Ctx: ${stats.context}`);
        if (stats.tokensIn) parts.push(`In: ${stats.tokensIn}`);
        if (stats.tokensOut) parts.push(`Out: ${stats.tokensOut}`);
        return parts.length > 0 ? `\n_${parts.join(' · ')}_` : '';
    }

    _extractSessionStats(output) {
        const stats = {};
        const lines = output.split('\n');
        // Track whether we've seen the live OMC HUD `ctx:NN%` field. Once we
        // have, ignore any later `Ctx(u): N.N%` matches: the latter comes from
        // a one-time /context snapshot in scrollback and goes stale while the
        // HUD updates every poll cycle.
        let liveCtxSeen = false;
        for (const line of lines) {
            // Match: Model: Opus 4.6⎇ mainCtx(u): 12.2% | In: 73Out: 1.9k | Cost: $0.24
            const modelMatch = line.match(/Model:\s*(.+?)(?:⎇|$)/);
            if (modelMatch) stats.model = modelMatch[1].trim();

            // Live OMC HUD footer: `... | ctx:39% | ...` (lowercase, no parens).
            // Preferred over the legacy `Ctx(u):` form because it reflects the
            // current turn — the HUD is repainted on every poll, whereas the
            // old `Ctx(u):` figure is captured from a /context dump that
            // rapidly scrolls past the 200-line tmux capture window.
            const ctxLiveMatch = line.match(/\bctx:\s*([\d.]+%)/);
            if (ctxLiveMatch) {
                stats.context = ctxLiveMatch[1];
                liveCtxSeen = true;
            }
            if (!liveCtxSeen) {
                const ctxMatch = line.match(/Ctx\(u\):\s*([\d.]+%)/);
                if (ctxMatch) stats.context = ctxMatch[1];
            }

            // Codex live footer:
            //   gpt-5.5 high · /var/go/src/github.com/payments · Context 36% used · 5h 99% · weekly 87%
            // The whole footer sits on a single line, so `Context NN% used` is
            // the authoritative live value. Always overrides earlier matches.
            const codexFooter = line.match(/^([a-z][\w.-]*\s+(?:high|medium|low|max|min))\s+·.*?Context\s+([\d.]+%)\s+used/i);
            if (codexFooter) {
                stats.model = codexFooter[1].trim();
                stats.context = codexFooter[2];
                liveCtxSeen = true;
            } else {
                const codexCtx = line.match(/Context\s+([\d.]+%)\s+used/);
                if (codexCtx) {
                    stats.context = codexCtx[1];
                    liveCtxSeen = true;
                }
            }

            const inMatch = line.match(/In:\s*([\d,.]+[kmb]?)/i);
            if (inMatch) stats.tokensIn = inMatch[1];

            const outMatch = line.match(/Out:\s*([\d,.]+[kmb]?)/i);
            if (outMatch) stats.tokensOut = outMatch[1];

            const costMatch = line.match(/Cost:\s*(\$[\d.]+)/);
            if (costMatch) stats.cost = costMatch[1];
        }
        return Object.keys(stats).length > 0 ? stats : null;
    }

    _autoApprove(sessionName, output) {
        this.logger.info(`Auto-approving confirmation in ${sessionName}`);

        if (output.includes('2. Yes, and don\'t ask again')) {
            exec(`tmux send-keys -t ${sessionName} '2'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        } else if (output.includes('1. Yes')) {
            exec(`tmux send-keys -t ${sessionName} '1'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        } else if (output.includes('(y/n)') || output.includes('[Y/n]')) {
            exec(`tmux send-keys -t ${sessionName} 'y'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        } else if (output.includes('Shell awaiting input')) {
            // Gemini's TUI parks the outer agent on `! Shell awaiting input (Tab to focus)`
            // when a shell tool either prompts for stdin or, more commonly, when --yolo
            // doesn't cover the MAX_TURNS recovery turn. Pressing Escape cancels the
            // stuck shell so the agent can finish its turn and fire AfterAgent.
            // Without this the alert investigation report never lands in Slack and the
            // poller falls back to its watchdog (Bug #1 from incident Q0OWCEYQW7VRLU).
            exec(`tmux send-keys -t ${sessionName} Escape`);
        }
    }

    // ─── Hook Watchdog (rescue path for silently-lost alert reports) ─────────
    //
    // When the alert poller bails out ("hook will post") but the CLI never
    // actually fires its turn-final hook (stuck on a tool prompt, crash, OOM,
    // Gemini MAX_TURNS recovery without YOLO), the investigation is silently
    // dropped. This watchdog gives the hook a short window to fire; if it
    // doesn't, we post the accumulated tmux buffer as a partial report so the
    // user always gets *something* back.
    _armHookWatchdog({ sessionKey, sessionName, channelId, threadTs, alertMessageTs, buffer, cliType, timeoutMs }) {
        if (!alertMessageTs) return;
        const startedAt = Date.now();
        const checkIntervalMs = 5000;

        const finalize = async () => {
            try {
                await this._removeReaction(channelId, alertMessageTs, 'eyes');
                await this._addReaction(channelId, alertMessageTs, 'white_check_mark');
            } catch (err) {
                this.logger.warn(`Hook watchdog: reaction swap failed: ${err.message}`);
            }
        };

        const tick = async () => {
            try {
                const session = sessionKey ? this._getSession(sessionKey) : null;
                if (session?.lastBotTs) {
                    this.logger.info(`Hook watchdog: hook posted for ${sessionName} after ${Math.round((Date.now() - startedAt) / 1000)}s — clean handoff`);
                    await finalize();
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    this.logger.warn(`Hook watchdog timed out (${Math.round(timeoutMs / 1000)}s) for ${sessionName} — posting accumulated buffer (${buffer ? buffer.length : 0} chars) as partial report`);
                    try {
                        await this._postPartialAlertReport({ channelId, threadTs, buffer, cliType, sessionKey });
                    } catch (err) {
                        this.logger.error(`Hook watchdog: failed to post partial buffer: ${err.message}`);
                    }
                    await finalize();
                    return;
                }
                setTimeout(tick, checkIntervalMs);
            } catch (err) {
                this.logger.error(`Hook watchdog tick error for ${sessionName}: ${err.message}`);
                await finalize();
            }
        };

        setTimeout(tick, checkIntervalMs);
    }

    async _postPartialAlertReport({ channelId, threadTs, buffer, cliType, sessionKey }) {
        const trimmed = (buffer || '').trim();
        if (!trimmed) {
            this.logger.warn(`Hook watchdog: empty buffer — nothing to post (channel=${channelId} thread=${threadTs})`);
            return;
        }
        const banner = `:warning: \`${cliType || 'cli'}\` did not deliver a turn-final message (stuck on a tool prompt or exceeded its turn budget). Posting captured terminal output as a partial report — clean version will follow if the hook eventually fires.`;
        try {
            await this.app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: banner,
            });
        } catch (err) {
            this.logger.error(`Failed to post partial banner: ${err.message}`);
        }
        const say = ({ text, thread_ts, blocks }) =>
            this.app.client.chat.postMessage({ channel: channelId, text, thread_ts, blocks });
        await this._sendResponse(say, threadTs, trimmed, null);
        if (sessionKey) {
            this._updateLastBotTs(sessionKey, String(Date.now() / 1000));
        }
    }

    async _sendResponse(say, threadTs, response, stats) {
        const codeWrap = '```\n';
        const codeWrapEnd = '\n```';
        const maxLen = 3000 - codeWrap.length - codeWrapEnd.length; // Slack section block text limit is 3000
        const statsLine = this._formatStatsLine(stats);

        if (response.length <= maxLen) {
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text: codeWrap + response + codeWrapEnd } }
            ];
            if (statsLine) {
                blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
            }
            await say({ text: response, thread_ts: threadTs, blocks });
        } else {
            const chunks = [];
            for (let i = 0; i < response.length; i += maxLen) {
                chunks.push(response.substring(i, i + maxLen));
            }
            for (let i = 0; i < chunks.length; i++) {
                const blocks = [
                    { type: 'section', text: { type: 'mrkdwn', text: codeWrap + chunks[i] + codeWrapEnd } }
                ];
                // Add stats to the last chunk only
                if (i === chunks.length - 1 && statsLine) {
                    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
                }
                await say({ text: chunks[i], thread_ts: threadTs, blocks });
            }
        }

        await this._uploadResponseAttachments(threadTs, response);
    }

    /**
     * Scan a CLI response for `Attachment written: <path>` markers and upload each
     * referenced file to the thread. Mirrors the alert-summary upload flow so that
     * normal @mention chat can deliver large supporting files (logs, dumps, reports)
     * the same way PagerDuty investigations do.
     */
    _extractAttachmentPaths(response) {
        if (!response || typeof response !== 'string') return [];
        const paths = [];
        const seen = new Set();
        const re = /Attachment written:\s*`?([^\s`\n]+)`?/gi;
        let m;
        while ((m = re.exec(response)) !== null) {
            const cleaned = m[1].replace(/[.,;:!?)\]]+$/, '').trim();
            if (cleaned && !seen.has(cleaned)) {
                seen.add(cleaned);
                paths.push(cleaned);
            }
        }
        return paths;
    }

    _getRepoPathForThread(threadTs) {
        try {
            const row = this.db.prepare('SELECT repo_path FROM sessions WHERE thread_ts = ?').get(threadTs);
            return row ? row.repo_path : null;
        } catch { return null; }
    }

    async _uploadResponseAttachments(threadTs, response) {
        const candidates = this._extractAttachmentPaths(response);
        if (!candidates.length) return;

        const channelId = this._getChannelForThread(threadTs) || this.config.channelId;
        const repoPath = this._getRepoPathForThread(threadTs) || this.config.repoPath || process.cwd();

        for (const rel of candidates) {
            const abs = path.isAbsolute(rel) ? rel : path.resolve(repoPath, rel);
            try {
                const stat = fs.statSync(abs);
                if (!stat.isFile()) {
                    this.logger.warn(`Attachment path is not a regular file, skipping: ${abs}`);
                    continue;
                }
                await this.app.client.filesUploadV2({
                    channel_id: channelId,
                    thread_ts: threadTs,
                    file: fs.createReadStream(abs),
                    filename: path.basename(abs),
                    title: path.basename(abs),
                });
                this.logger.info(`Uploaded chat attachment ${abs} (${stat.size} bytes) to thread ${threadTs}`);
            } catch (err) {
                this.logger.warn(`Failed to upload attachment "${rel}" (resolved=${abs}): ${err.message}`);
            }
        }
    }

    /**
     * Extract the Recommended Action section from an alert investigation response.
     * Looks for text between "Recommended Action:" and the next "---" or section boundary.
     */
    _extractRecommendedAction(response) {
        // Colon is optional: the alert skill / nudge emits a `## Recommended Action`
        // heading (no colon). Accept both heading and label forms.
        const head = '(?:#{1,3}\\s+)?(?:\\*\\*)?Recommended Action(?:\\*\\*)?:?\\s*';
        // Match the section content up to next "---" or "##" or "**"
        const match = response.match(new RegExp(head + '([\\s\\S]*?)(?:\\n\\s*---|\\n\\n##|\\n\\n\\*\\*)', 'i'));
        if (match) {
            return match[1].trim();
        }
        // Fallback: take first paragraph after the heading, or first 500 chars
        const paraMatch = response.match(new RegExp(head + '(.+(?:\\n(?!\\n).+)*)', 'i'));
        if (paraMatch) {
            return paraMatch[1].trim();
        }
        return response.substring(0, 500).trim();
    }

    /**
     * Send alert summary: Recommended Action as Slack message + full report as file upload.
     */
    async _sendAlertSummary(say, threadTs, response, stats) {
        // Validate content quality: reject intermediate narration / partial output.
        // Real investigation reports are 500+ chars and contain a proper "Recommended Action" heading.
        const MIN_REPORT_LEN = 500;
        const isValidReport = response && response.length >= MIN_REPORT_LEN
            && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:?/im.test(response);

        if (!isValidReport) {
            this.logger.warn(`Alert summary rejected: content doesn't look like a real report (${(response || '').length} chars) — posting incomplete notice`);
            await say({ text: ':warning: Investigation incomplete — Claude exited before producing a report.', thread_ts: threadTs });

            // Upload raw Claude output so owner can debug what happened (tmux is gone by now)
            if (response) {
                try {
                    const channelId = this._getChannelForThread(threadTs);
                    await this.app.client.filesUploadV2({
                        channel_id: channelId || this.config.channelId,
                        thread_ts: threadTs,
                        content: response,
                        filename: `alert-raw-output-${Date.now()}.txt`,
                        title: 'Raw Claude Output (debug)',
                        initial_comment: '_Raw Claude output attached for debugging._',
                    });
                } catch (err) {
                    this.logger.error(`Failed to upload raw debug output: ${err.message}`);
                }
            }
            return;
        }

        const summary = this._extractRecommendedAction(response);
        const statsLine = this._formatStatsLine(stats);

        // Post the summary (Recommended Action only), truncate to stay under 3000-char block limit
        const maxSummaryLen = 2970; // 3000 limit minus "*Recommended Action:* " prefix
        const trimmedSummary = summary.length > maxSummaryLen
            ? summary.substring(0, maxSummaryLen) + '…' : summary;
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${trimmedSummary}` } }
        ];
        if (statsLine) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
        }
        await say({ text: `Recommended Action: ${summary}`, thread_ts: threadTs, blocks });

        // Upload full report as a text file
        try {
            const channelId = this._getChannelForThread(threadTs);
            await this.app.client.filesUploadV2({
                channel_id: channelId || this.config.channelId,
                thread_ts: threadTs,
                content: response,
                filename: `alert-investigation-${Date.now()}.md`,
                title: 'Full Investigation Report',
                initial_comment: '_Full investigation details attached._',
            });
        } catch (err) {
            this.logger.error(`Failed to upload alert report file: ${err.message}`);
            // Fallback: send full response as regular messages
            await this._sendResponse(say, threadTs, response, stats);
        }
    }

    /**
     * Look up the channel ID for a given thread timestamp from stored sessions.
     */
    _getChannelForThread(threadTs) {
        try {
            const row = this.db.prepare('SELECT channel_id FROM sessions WHERE thread_ts = ?').get(threadTs);
            return row ? row.channel_id : null;
        } catch { return null; }
    }

    // ─── HTTP Server ─────────────────────────────────────────────────

    _setupHttpServer() {
        const httpApp = express();
        // Capture raw body for PagerDuty HMAC verification (must be before generic json parser)
        httpApp.use('/pagerduty', express.json({
            verify: (req, _res, buf) => { req.rawBody = buf; }
        }));
        httpApp.use(express.json());

        const swaggerDoc = {
            openapi: '3.0.0',
            info: {
                title: 'Claude Code Remote - Slack Agent API',
                version: '1.0.0',
                description: 'HTTP API for managing the Slack-based Claude Code Remote agent'
            },
            servers: [{ url: `http://localhost:${this.httpPort}` }],
            paths: {
                '/': {
                    get: {
                        summary: 'Health check',
                        responses: {
                            '200': {
                                description: 'Service status',
                                content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, service: { type: 'string' }, uptime: { type: 'number' }, sessions: { type: 'number' } } } } }
                            }
                        }
                    }
                },
                '/delete-message': {
                    post: {
                        summary: 'Delete a Slack message by URL',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C0AJ3JPRA9L/p1772808507330479?thread_ts=1772802618.748569&cid=C0AJ3JPRA9L' } } } } }
                        },
                        responses: {
                            '200': { description: 'Message deleted successfully' },
                            '400': { description: 'Invalid URL format' },
                            '500': { description: 'Failed to delete message' }
                        }
                    }
                },
                '/remove-reaction': {
                    post: {
                        summary: 'Remove all bot reactions from a Slack message',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C0AJ3JPRA9L/p1772808507330479?thread_ts=1772802618.748569&cid=C0AJ3JPRA9L' } } } } }
                        },
                        responses: {
                            '200': { description: 'Reactions removed successfully', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, channel: { type: 'string' }, ts: { type: 'string' }, removed: { type: 'array', items: { type: 'string' } } } } } } },
                            '400': { description: 'Missing or invalid URL' },
                            '500': { description: 'Failed to remove reactions' }
                        }
                    }
                },
                '/trigger-alert': {
                    post: {
                        summary: 'Manually trigger an alert investigation session',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C07DEF456/p1709123456789012' } } } } }
                        },
                        responses: {
                            '200': { description: 'Investigation started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channelId: { type: 'string' }, messageTs: { type: 'string' } } } } } },
                            '400': { description: 'Missing/invalid URL or bad JSON' },
                            '405': { description: 'Wrong HTTP method' },
                            '409': { description: 'Session already exists for this message' },
                            '503': { description: 'Slack app not initialized yet' }
                        }
                    }
                },
                '/trigger-delay-alert': {
                    post: {
                        summary: 'Manually trigger a delay alert investigation session',
                        description: 'Bypasses counter/threshold — immediately starts a delay alert investigation using the configured delay skill.',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/CPP5EH3A8/p1775389830277889' } } } } }
                        },
                        responses: {
                            '200': { description: 'Investigation started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channelId: { type: 'string' }, messageTs: { type: 'string' }, skill: { type: 'string' } } } } } },
                            '400': { description: 'Missing/invalid URL or bad JSON' },
                            '409': { description: 'Session already exists for this message' },
                            '503': { description: 'Slack app not initialized yet' }
                        }
                    }
                },
                '/sessions': {
                    get: {
                        summary: 'List active Claude tmux sessions',
                        responses: {
                            '200': {
                                description: 'Active sessions',
                                content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { type: 'object' } } } } } }
                            }
                        }
                    },
                    delete: {
                        summary: 'Kill all Claude tmux sessions and clean up',
                        description: 'Kills all tmux sessions, stops pollers, clears timers, and deletes DB records.',
                        responses: {
                            '200': {
                                description: 'Sessions killed',
                                content: { 'application/json': { schema: { type: 'object', properties: { killed: { type: 'number' }, already_dead: { type: 'number' } } } } }
                            }
                        }
                    }
                },
                '/delay-counters': {
                    get: {
                        summary: 'Show delay alert counters',
                        description: 'Returns current alert counters per DAG with count, threshold, and time remaining in window.',
                        responses: {
                            '200': {
                                description: 'Delay alert counters',
                                content: { 'application/json': { schema: { type: 'object', properties: { threshold: { type: 'number' }, windowMs: { type: 'number' }, counters: { type: 'array', items: { type: 'object', properties: { dag: { type: 'string' }, count: { type: 'number' }, threshold: { type: 'number' }, firstSeen: { type: 'string' }, windowRemainingMs: { type: 'number' }, channelId: { type: 'string' } } } } } } } }
                            }
                        }
                    }
                },
                '/daily-summary': {
                    post: {
                        summary: 'Manually trigger daily channel summary',
                        responses: {
                            '200': { description: 'Summary triggered', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channels: { type: 'number' } } } } } },
                            '400': { description: 'No channels configured' },
                            '500': { description: 'Failed to run summary' }
                        }
                    }
                },
                '/sso-status': {
                    get: {
                        summary: 'SSO pre-warm watcher status',
                        description: 'Reports per-profile last-warm timestamp, duration, error, and consecutive failure count for the SSO credential server.',
                        responses: {
                            '200': { description: 'Watcher status', content: { 'application/json': { schema: { type: 'object' } } } }
                        }
                    },
                    post: {
                        summary: 'Force an SSO pre-warm tick now',
                        description: 'Runs one pre-warm cycle against all configured profiles immediately (useful for verifying recovery without waiting for the next interval).',
                        responses: {
                            '200': { description: 'Warm completed', content: { 'application/json': { schema: { type: 'object' } } } },
                            '503': { description: 'SSO pre-warm not enabled' }
                        }
                    }
                }
            }
        };

        const swaggerUi = require('swagger-ui-express');
        httpApp.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

        httpApp.get('/', (req, res) => {
            const sessions = this._getAllSessions();
            const aliveSessions = sessions.filter(s => this._isTmuxSessionAlive(s.sessionName));
            const recentErrors = this._wsErrors.filter(ts => ts > Date.now() - this._wsErrorWindowMs).length;
            const status = this.connected && recentErrors < 5
                ? 'ok'
                : (recentErrors >= 10 ? 'critical' : 'degraded');
            res.json({
                status,
                service: 'claude-code-remote-slack',
                socketConnected: this.connected,
                wsErrorsInWindow: recentErrors,
                wsRestartsIn10min: this._getRestartsInWindow(),
                uptime: process.uptime(),
                sessions: aliveSessions.length,
                totalSessionsInDb: sessions.length
            });
        });

        httpApp.post('/delete-message', async (req, res) => {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'url is required' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL' });
            }

            try {
                const { WebClient } = require('@slack/web-api');
                const web = new WebClient(this.config.botToken);
                await web.chat.delete({
                    channel: parsed.channel,
                    ts: parsed.ts
                });
                this.logger.info(`Deleted message: channel=${parsed.channel} ts=${parsed.ts}`);
                res.json({ ok: true, channel: parsed.channel, ts: parsed.ts });
            } catch (error) {
                this.logger.error('Failed to delete message:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.post('/remove-reaction', async (req, res) => {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'url is required' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL' });
            }

            try {
                const { WebClient } = require('@slack/web-api');
                const web = new WebClient(this.config.botToken);

                // Fetch reactions on the message
                const result = await web.reactions.get({
                    channel: parsed.channel,
                    timestamp: parsed.ts,
                    full: true
                });

                const botUserId = (await web.auth.test()).user_id;
                const reactions = result.message?.reactions || [];
                const botReactions = reactions.filter(r => r.users?.includes(botUserId));

                // Remove all reactions added by the bot
                const removed = [];
                for (const reaction of botReactions) {
                    await web.reactions.remove({
                        channel: parsed.channel,
                        timestamp: parsed.ts,
                        name: reaction.name
                    });
                    removed.push(reaction.name);
                }

                this.logger.info(`Removed ${removed.length} reaction(s) from channel=${parsed.channel} ts=${parsed.ts}: ${removed.join(', ')}`);
                res.json({ ok: true, channel: parsed.channel, ts: parsed.ts, removed });
            } catch (error) {
                this.logger.error('Failed to remove reaction:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        // ─── Trigger Alert ─────────────────────────────────────
        httpApp.post('/trigger-alert', async (req, res) => {
            if (!this.app) {
                return res.status(503).json({ error: 'Slack app not initialized yet' });
            }

            const { url } = req.body || {};
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" field. Provide a Slack message permalink.' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL format. Expected: https://<workspace>.slack.com/archives/<channel>/p<timestamp>' });
            }

            const channelId = parsed.channel;
            const messageTs = parsed.ts;
            this.logger.info(`Trigger-alert received: channelId=${channelId} messageTs=${messageTs}`);

            // Check for duplicate
            const sessionKey = `${channelId}-${messageTs}`;
            if (this._getSession(sessionKey)) {
                this.logger.warn(`Trigger-alert skipped: session already exists for ${sessionKey}`);
                return res.status(409).json({ error: 'Session already exists for this message', channelId, messageTs });
            }

            try {
                // Fetch the message from Slack
                const historyResult = await this.app.client.conversations.history({
                    channel: channelId,
                    latest: messageTs,
                    inclusive: true,
                    limit: 1
                });

                const message = historyResult.messages?.[0];
                if (!message) {
                    return res.status(400).json({ error: 'Could not fetch message from Slack' });
                }

                const text = message.text || '';
                const incidentId = this.alertMonitor.extractIncidentId(message);

                // React with eyes
                await this._addReaction(channelId, messageTs, 'eyes');

                // Download images
                const imagePaths = await this._downloadSlackImages(message.files, `alert-${messageTs.replace('.', '')}`);
                const imageInstruction = imagePaths.length > 0
                    ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                    : '';

                // Build prompt via the first CLI in the configured chain
                const permalink = await this._getPermalink(channelId, messageTs);
                const alertSkill = this.config.alertSkill;
                const triggerCliChain = this.config.alertCliChain || ['claude'];
                const triggerAdapter = getCliAdapter(triggerCliChain[0]);
                const prompt = triggerAdapter.buildAlertPrompt({
                    skill: alertSkill,
                    permalink,
                    fallbackText: text,
                    imageInstruction,
                    fallbackIntro: 'Investigate this alert',
                });

                // Manual trigger — bypass queue, process immediately
                await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs, null, triggerCliChain);
                res.json({ status: 'investigating', channelId, messageTs });
            } catch (error) {
                this.logger.error(`Trigger alert error: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.post('/trigger-delay-alert', async (req, res) => {
            if (!this.app) {
                return res.status(503).json({ error: 'Slack app not initialized yet' });
            }

            const { url } = req.body || {};
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" field. Provide a Slack message permalink.' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL format. Expected: https://<workspace>.slack.com/archives/<channel>/p<timestamp>' });
            }

            const channelId = parsed.channel;
            const messageTs = parsed.ts;
            this.logger.info(`Trigger-delay-alert received: channelId=${channelId} messageTs=${messageTs}`);

            // Check for duplicate
            const sessionKey = `${channelId}-${messageTs}`;
            if (this._getSession(sessionKey)) {
                this.logger.warn(`Trigger-delay-alert skipped: session already exists for ${sessionKey}`);
                return res.status(409).json({ error: 'Session already exists for this message', channelId, messageTs });
            }

            try {
                // Fetch the message from Slack
                const historyResult = await this.app.client.conversations.history({
                    channel: channelId,
                    latest: messageTs,
                    inclusive: true,
                    limit: 1
                });

                const message = historyResult.messages?.[0];
                if (!message) {
                    return res.status(400).json({ error: 'Could not fetch message from Slack' });
                }

                const text = message.text || '';

                // React with eyes
                await this._addReaction(channelId, messageTs, 'eyes');

                // Download images
                const imagePaths = await this._downloadSlackImages(message.files, `delay-alert-${messageTs.replace('.', '')}`);
                const imageInstruction = imagePaths.length > 0
                    ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                    : '';

                // Build prompt via the first CLI in the DELAY_ALERT_CLI chain
                const permalink = await this._getPermalink(channelId, messageTs);
                const skill = this.delayAlertMonitor.skill;
                const triggerDelayCliChain = this.config.delayAlertCliChain || ['claude'];
                const triggerDelayAdapter = getCliAdapter(triggerDelayCliChain[0]);
                const prompt = triggerDelayAdapter.buildAlertPrompt({
                    skill,
                    permalink,
                    fallbackText: text,
                    imageInstruction,
                    fallbackIntro: 'Investigate this Airflow delay alert',
                });

                // DM owner that investigation is starting (manual trigger)
                const alertInfo = this.delayAlertMonitor.extractAlertInfo(message);
                this._notifyOwnerDelayAlert(
                    alertInfo?.dag || 'manual-trigger',
                    alertInfo?.task || 'N/A',
                    0,
                    { permalink }
                ).catch(err =>
                    this.logger.error(`Failed to notify owner of delay alert: ${err.message}`)
                );

                // Use the regular command flow
                await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs, null, triggerDelayCliChain);
                res.json({ status: 'investigating', channelId, messageTs, skill: skill || 'none' });
            } catch (error) {
                this.logger.error(`Trigger delay alert error: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.post('/queue/kick', (req, res) => {
            this._processNextInQueue();
            res.status(204).end();
        });

        httpApp.get('/queue', (req, res) => {
            const items = this._queueStmts.all.all();
            const pending = items.filter(i => i.status === 'pending').length;
            const processing = items.filter(i => i.status === 'processing').length;
            res.json({
                maxConcurrent: this.config.alertMaxConcurrent || 1,
                pending,
                processing,
                items: items.map(i => ({
                    id: i.id,
                    incident_id: i.incident_id,
                    channel_id: i.channel_id,
                    message_ts: i.message_ts,
                    status: i.status,
                    alert_type: i.alert_type,
                    created_at: new Date(i.created_at).toISOString(),
                    updated_at: new Date(i.updated_at).toISOString(),
                }))
            });
        });

        httpApp.get('/delay-counters', (req, res) => {
            const now = Date.now();
            const rows = this.delayAlertMonitor.getAllCounters();
            const threshold = this.delayAlertMonitor.threshold;
            const windowMs = this.delayAlertMonitor.windowMs;
            const counters = rows.map(r => {
                const elapsed = now - r.first_seen_at;
                const remaining = Math.max(0, windowMs - elapsed);
                return {
                    dag: r.dag_name,
                    count: r.count,
                    threshold,
                    progress: `${r.count}/${threshold}`,
                    firstSeen: new Date(r.first_seen_at).toISOString(),
                    windowRemainingMs: remaining,
                    windowRemaining: `${Math.round(remaining / 60000)}m`,
                    expired: remaining === 0,
                    channelId: r.channel_id,
                };
            });
            res.json({ threshold, windowMs, counters });
        });

        httpApp.get('/sessions', (req, res) => {
            const sessions = this._getAllSessions().map(s => ({
                ...s,
                tmuxAlive: this._isTmuxSessionAlive(s.sessionName),
                createdAt: new Date(s.createdAt).toISOString(),
                updatedAt: new Date(s.updatedAt).toISOString()
            }));
            res.json({ sessions });
        });

        httpApp.delete('/sessions', (req, res) => {
            const sessions = this._getAllSessions();
            let killed = 0;
            let alreadyDead = 0;

            for (const s of sessions) {
                // Kill tmux
                if (this._isTmuxSessionAlive(s.sessionName)) {
                    try { execSync(`tmux kill-session -t ${s.sessionName} 2>/dev/null`); } catch (_) {}
                    killed++;
                } else {
                    alreadyDead++;
                }

                // Stop poller
                if (this.pollers.has(s.sessionName)) {
                    clearInterval(this.pollers.get(s.sessionName).interval);
                    this.pollers.delete(s.sessionName);
                }

                // Clear timer
                this._clearSessionTimeout(s.sessionKey);

                // Swap alert reactions
                if (s.alertMessageTs) {
                    this._removeReaction(s.channelId, s.alertMessageTs, 'eyes').catch(() => {});
                    this._addReaction(s.channelId, s.alertMessageTs, 'white_check_mark').catch(() => {});
                }

                // Delete DB record
                this._deleteSession(s.sessionKey);
            }

            this.logger.info(`DELETE /sessions: ${killed} killed, ${alreadyDead} already dead, ${sessions.length} DB records removed`);
            res.json({ killed, already_dead: alreadyDead });
        });

        // ─── Daily Summary ────────────────────────────────────
        httpApp.post('/daily-summary', async (req, res) => {
            const channels = parseChannelsConfig(this.config.dailySummaryChannels);
            if (channels.length === 0) {
                return res.status(400).json({ error: 'No DAILY_SUMMARY_CHANNELS configured' });
            }

            res.json({ status: 'triggered', channels: channels.length });

            // Run async (don't block the HTTP response)
            runDailySummary({
                channels,
                ownerUserId: this.config.ownerUserId,
                model: this.config.dailySummaryModel || 'sonnet',
                xoxcToken: this.config.xoxcToken,
                xoxdToken: this.config.xoxdToken,
                slackClient: this.app.client,
                deliveryChannelId: this.config.channelId,
            }).catch(err => this.logger.error(`Daily summary error: ${err.message}`));
        });

        // Entity Plan D: Mac-runner queue endpoints (token-authed).
        const { makeRunnerHandlers } = require('./runner-endpoints');
        const runnerHandlers = makeRunnerHandlers({
            // Resolved per request, not captured: _initDb() replaces this.jobs
            // on every daily restart.
            jobs: () => this.jobs,
            token: process.env.RUNNER_TOKEN || '',
            onResult: (job) => this._onJobResult(job),
            onFail: (job) => this._onJobFailed(job),
            onPaneEvent: (job, event) => this._onPaneEvent(job, event),
        });
        httpApp.post('/runner/lease', (req, res) => runnerHandlers.lease(req, res));
        httpApp.post('/runner/complete', (req, res) => runnerHandlers.complete(req, res));
        httpApp.post('/runner/fail', (req, res) => runnerHandlers.fail(req, res));
        httpApp.post('/jobs', (req, res) => runnerHandlers.enqueue(req, res));
        httpApp.post('/pane-event', (req, res) =>
            runnerHandlers.paneEvent(req, res));

        httpApp.get('/sso-status', (req, res) => {
            if (!this.ssoPrewarm) {
                return res.json({ enabled: false });
            }
            res.json(this.ssoPrewarm.getStatus());
        });

        httpApp.post('/sso-status', async (req, res) => {
            if (!this.ssoPrewarm) {
                return res.status(503).json({ error: 'SSO pre-warm not enabled' });
            }
            try {
                const status = await this.ssoPrewarm.warmOnce();
                res.json(status);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // ─── PagerDuty Webhook (fallback for Socket Mode) ──────────
        httpApp.post('/pagerduty/webhook', async (req, res) => {
            // Verify HMAC signature
            if (!this._verifyPagerDutySignature(req)) {
                this.logger.warn('PD webhook rejected: invalid signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }

            const event = req.body?.event;

            // Only handle incident.triggered
            if (!event || event.event_type !== 'incident.triggered') {
                return res.status(200).json({ status: 'ignored', reason: event?.event_type || 'unknown' });
            }

            const incidentId = event.data?.id;
            if (!incidentId) {
                return res.status(200).json({ status: 'ignored', reason: 'no incident ID' });
            }

            // Dedup — skip if Socket Mode already handled it, but notify owner
            if (this.trackedIncidents.has(incidentId)) {
                this.logger.info(`PD webhook: incident ${incidentId} already tracked — skipping`);
                res.status(200).json({ status: 'skipped', incidentId });
                // Notify owner with link to the Slack message we already acked
                this._notifyOwnerIncidentWebhook(incidentId, event.data, { alreadyAcked: true }).catch(err =>
                    this.logger.error(`Failed to notify owner of incident webhook: ${err.message}`)
                );
                return;
            }

            this.logger.info(`PD webhook: new incident ${incidentId}`);

            // Respond immediately — process async
            res.status(200).json({ status: 'accepted', incidentId });

            // Async: ACK PagerDuty and notify owner.
            // Investigation is handled by Socket Mode via the alert queue.
            // NOTE: Do NOT set trackedIncidents early — it blocks Socket Mode
            // from enqueuing the alert (was the cause of the race condition bug).
            try {
                // Acknowledge PD immediately (before searching for Slack message)
                if (this.config.pagerdutyApiToken) {
                    const pdResult = await this._acknowledgePagerDuty(incidentId);
                    if (pdResult?.skipped) {
                        this.logger.info(`PD webhook: incident ${incidentId} already ${pdResult.status}`);
                        this._notifyOwnerIncidentAcked(incidentId, event.data).catch(err =>
                            this.logger.error(`Failed to notify owner of acked incident: ${err.message}`)
                        );
                        return;
                    }
                }

                // Find the Slack message for the permalink (for owner notification)
                const found = await this._findPagerDutySlackMessage(incidentId);
                if (!found) {
                    this.logger.info(`PD webhook: Slack message not found for ${incidentId} — Socket Mode will handle`);
                    // Notify owner without permalink
                    this._notifyOwnerIncidentWebhook(incidentId, event.data, {}).catch(err =>
                        this.logger.error(`Failed to notify owner of incident webhook: ${err.message}`)
                    );
                    return;
                }

                const { channelId, message } = found;
                const messageTs = message.ts;
                const permalink = await this._getPermalink(channelId, messageTs);

                // Notify owner
                this._notifyOwnerIncidentWebhook(incidentId, event.data, { permalink }).catch(err =>
                    this.logger.error(`Failed to notify owner of incident webhook: ${err.message}`)
                );

                // Fallback: if Socket Mode is disconnected, enqueue from webhook
                // (Socket Mode won't receive the Slack message, so nobody else will enqueue)
                if (!this.connected) {
                    this.logger.warn(`PD webhook: Socket Mode disconnected — enqueueing ${incidentId} as fallback`);
                    this.trackedIncidents.set(incidentId, { channelId, messageTs });

                    const imagePaths = await this._downloadSlackImages(message.files, `alert-${messageTs.replace('.', '')}`);
                    const imageInstruction = imagePaths.length > 0
                        ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                        : '';
                    const text = message.text || '';
                    const alertSkill = this.config.alertSkill;
                    const webhookCliChain = this.config.alertCliChain || ['claude'];
                    const webhookAdapter = getCliAdapter(webhookCliChain[0]);
                    const prompt = webhookAdapter.buildAlertPrompt({
                        skill: alertSkill,
                        permalink,
                        fallbackText: text,
                        imageInstruction,
                        fallbackIntro: 'Investigate this PagerDuty alert',
                    });

                    const position = this._enqueueAlert({ incidentId, channelId, messageTs, prompt, alertType: 'pagerduty' });
                    if (position > 0) {
                        const activeSlots = this._queueStmts.countProcessing.get().count;
                        const maxConcurrent = this.config.alertMaxConcurrent || 1;
                        if (position === 1 && activeSlots < maxConcurrent) {
                            await this._addReaction(channelId, messageTs, 'eyes');
                        } else {
                            await this._addReaction(channelId, messageTs, 'hourglass_flowing_sand');
                        }
                        this._processNextInQueue();
                    }
                } else {
                    this.logger.info(`PD webhook: ACKed ${incidentId}, Socket Mode will handle investigation via queue`);
                }
            } catch (err) {
                this.logger.error(`PD webhook error for ${incidentId}: ${err.message}`);
                this.trackedIncidents.delete(incidentId);
            }
        });

        this._httpApp = httpApp;
    }

    _verifyPagerDutySignature(req) {
        const secret = this.config.pagerdutyWebhookSecret;
        if (!secret) return true; // No secret configured — allow all
        const signature = req.headers['x-pagerduty-signature'];
        if (!signature) return false;
        const crypto = require('crypto');
        const expected = 'v1=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        } catch {
            return false;
        }
    }

    async _findPagerDutySlackMessage(incidentId) {
        const channelIds = [...this.alertMonitor.monitoredChannelIds];
        if (channelIds.length === 0) return null;

        const delays = [2000, 5000, 10000];
        for (let attempt = 0; attempt < delays.length + 1; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt - 1]));

            for (const channelId of channelIds) {
                try {
                    const result = await this.app.client.conversations.history({
                        channel: channelId,
                        limit: 20,
                        oldest: String((Date.now() / 1000 - 120).toFixed(6)),
                    });
                    for (const msg of (result.messages || [])) {
                        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;
                        if (this.alertMonitor.extractIncidentId(msg) === incidentId) {
                            this.logger.info(`PD webhook: found Slack message for ${incidentId} in ${channelId} (attempt ${attempt + 1})`);
                            return { channelId, message: msg };
                        }
                    }
                } catch (err) {
                    this.logger.error(`PD webhook: search error in ${channelId}: ${err.message}`);
                }
            }
        }
        return null;
    }

    _parseSlackUrl(url) {
        try {
            const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
            if (!match) return null;

            const channel = match[1];
            const rawTs = match[2];
            const ts = rawTs.slice(0, -6) + '.' + rawTs.slice(-6);

            return { channel, ts };
        } catch {
            return null;
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    async start() {
        const t0 = Date.now();

        // Re-initialize DB if it was closed (e.g. after stop() during daily restart)
        if (!this.db || !this.db.open) {
            this._initDb();
            // Re-init delay alert monitor's DB reference and counters table
            this.delayAlertMonitor.db = this.db;
            this.delayAlertMonitor._initCountersTable();
        }

        // Ensure tmux server is running — without a server, session creation fails.
        // This can happen after a service restart when no tmux sessions exist.
        this._ensureTmuxServer();

        // Reconcile DB sessions with live tmux sessions
        await this._reconcileSessions();
        this._startSessionSweep();
        this._startStallMonitor();
        this.logger.info(`[startup] reconcileSessions: ${Date.now() - t0}ms`);

        const t1 = Date.now();
        await this.app.start();
        this.connected = true;
        this._setupConnectionMonitor();
        this._startHealthCheck();
        this.logger.info(`[startup] Slack Socket Mode connected: ${Date.now() - t1}ms`);

        // Resolve monitored channels
        const t2 = Date.now();
        await this.alertMonitor.resolveMonitorChannels();
        await this.delayAlertMonitor.resolveMonitorChannels();
        this.logger.info(`[startup] resolveMonitorChannels: ${Date.now() - t2}ms`);

        this.httpServer = this._httpApp.listen(this.httpPort, () => {
            this.logger.info(`[startup] HTTP API on port ${this.httpPort}`);
            this.logger.info(`[startup] total: ${Date.now() - t0}ms`);
        });

        // T11: Start graph-ingest subsystem if enabled
        if (process.env.GRAPH_INGEST_ENABLED === 'true') {
            await graphIngest.start({ app: this.app, logger: this.logger });
        }

        // Check for missed mentions after connection stabilizes
        setTimeout(() => this._replayMissedMentions().catch(err =>
            this.logger.error(`Failed to replay missed mentions: ${err.message}`)
        ), 3000);
    }

    async stop() {
        if (this._sweepInterval) {
            clearInterval(this._sweepInterval);
            this._sweepInterval = null;
        }

        if (this._stallMonitorInterval) {
            clearInterval(this._stallMonitorInterval);
            this._stallMonitorInterval = null;
        }

        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
            this._healthCheckInterval = null;
        }

        if (this._wsStabilityTimer) {
            clearTimeout(this._wsStabilityTimer);
            this._wsStabilityTimer = null;
        }

        if (this.httpServer) {
            await new Promise(resolve => this.httpServer.close(resolve));
            this.httpServer = null;
        }

        for (const [key, poller] of this.pollers) {
            clearInterval(poller.interval);
        }
        this.pollers.clear();

        for (const [, timer] of this.sessionTimers) {
            clearTimeout(timer);
        }
        this.sessionTimers.clear();

        // NOTE: We do NOT kill tmux sessions on stop.
        // They persist so conversations can resume after restart.

        if (this.db) {
            this.db.close();
        }

        // T11: Stop graph-ingest subsystem
        if (process.env.GRAPH_INGEST_ENABLED === 'true') {
            await graphIngest.stop();
        }

        await this.app.stop();
        this.logger.info('Slack Socket Mode disconnected (tmux sessions preserved)');
    }
}

module.exports = SlackSocketHandler;
