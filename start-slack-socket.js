#!/usr/bin/env node

/**
 * Slack Socket Mode Server
 * Starts the Slack Socket Mode connection for receiving messages
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('./src/core/logger');
const SlackSocketHandler = require('./src/channels/slack/socket');
const { runDailySummary, parseChannelsConfig } = require('./src/services/daily-summary');
const { SsoPrewarm } = require('./src/services/sso-prewarm');
const { BqHealthMonitor } = require('./src/services/bq-health');
const mcp = require('./src/mcp');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const logger = new Logger('Slack-Socket-Server');

// Parse a CSV CLI chain like "codex,claude" into a deduped lowercased array.
// Used for ALERT_CLI / DELAY_ALERT_CLI so the bot can fall back to the next
// CLI in the list when the preferred one fails to start (e.g. Codex quota
// exceeded). A single value ("codex") still works — it's just a one-element
// chain with no fallback. Empty / unset → default chain.
function parseCliChain(raw, defaultChain = ['claude']) {
    const parts = (raw || '')
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (parts.length === 0) return defaultChain.slice();
    const seen = new Set();
    const chain = [];
    for (const p of parts) {
        if (!seen.has(p)) {
            seen.add(p);
            chain.push(p);
        }
    }
    return chain;
}

// Load configuration
const config = {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    repoPath: process.env.SLACK_REPO_PATH || process.cwd(),
    repoRoot: process.env.SLACK_REPO_ROOT || '',
    claudeCommand: process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions',
    ownerUserId: process.env.SLACK_OWNER_USER_ID || '',
    whitelist: process.env.SLACK_WHITELIST ? process.env.SLACK_WHITELIST.split(',').map(id => id.trim()).filter(Boolean) : [],
    // Subteam (usergroup) IDs whose members may talk to the bot. When set (or
    // SLACK_WHITELIST is set), @mention access is locked down: only the owner
    // and these members get through. Members get RESTRICTED sessions (no
    // personal/server info); only the owner gets full access. Empty → open.
    allowedSubteams: process.env.SLACK_ALLOWED_SUBTEAMS ? process.env.SLACK_ALLOWED_SUBTEAMS.split(',').map(id => id.trim()).filter(Boolean) : [],
    httpPort: parseInt(process.env.SLACK_HTTP_PORT) || 9999,
    // Alert monitoring
    monitorChannels: process.env.MONITOR_CHANNELS || '',
    alertSkill: process.env.ALERT_SKILL || '',
    // CSV chain: `ALERT_CLI=codex,claude` → try Codex first, fall back to Claude
    // on fatal startup errors (e.g. quota exceeded). Single value still works.
    alertCliChain: parseCliChain(process.env.ALERT_CLI),
    sessionInactivityTimeoutMs: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_MS) || 300000,
    pollerTimeoutMs: parseInt(process.env.POLLER_TIMEOUT_MS) || 1800000, // 30 min
    pollerMaxWallMs: parseInt(process.env.POLLER_MAX_WALL_MS) || 0, // 0 → pollerTimeoutMs*4 (2h) in socket.js
    // Busy-loop stall: escalate an alert CLI to the next chain member when the
    // pane content (sans spinner/timer chrome) hasn't changed for this long while
    // the spinner is still up. Must exceed the longest legit silent tool call.
    pollerNoProgressMs: parseInt(process.env.POLLER_NO_PROGRESS_MS) || 360000, // 6 min
    // @mention reply watchdog: how long after injecting a command we post a
    // single "still working" ping if the Stop hook hasn't delivered a reply yet.
    inflightHeartbeatMs: parseInt(process.env.INFLIGHT_HEARTBEAT_MS) || 300000, // 5 min
    alertMaxConcurrent: parseInt(process.env.ALERT_MAX_CONCURRENT) || 1,
    pagerdutyApiToken: process.env.PAGERDUTY_API_TOKEN || '',
    pagerdutyFromEmail: process.env.PAGERDUTY_FROM_EMAIL || '',
    pagerdutyWebhookSecret: process.env.PAGERDUTY_WEBHOOK_SECRET || '',
    // Delay alert monitoring
    monitorDelayChannels: process.env.MONITOR_DELAY_CHANNELS || '',
    delayAlertThreshold: process.env.DELAY_ALERT_THRESHOLD || '3',
    delayAlertWindowMs: process.env.DELAY_ALERT_WINDOW_MS || '3600000',
    delayAlertTaskPatterns: process.env.DELAY_ALERT_TASK_PATTERNS || '',
    delayAlertSkill: process.env.DELAY_ALERT_SKILL || 'one:pay-ops-tax-production',
    // CSV chain, same semantics as ALERT_CLI.
    delayAlertCliChain: parseCliChain(process.env.DELAY_ALERT_CLI),
    // Daily summary
    dailySummaryChannels: process.env.DAILY_SUMMARY_CHANNELS || '',
    dailySummaryTime: process.env.DAILY_SUMMARY_TIME || '07:00',
    dailySummaryModel: process.env.DAILY_SUMMARY_MODEL || 'sonnet',
    xoxcToken: process.env.SLACK_XOXC_TOKEN || '',
    xoxdToken: process.env.SLACK_XOXD_TOKEN || '',
    // App mode: 'local' (mentions only), 'cloud' (monitors + summary only), 'all' (everything)
    appMode: (process.env.APP_MODE || 'all').toLowerCase(),
    // SSO pre-warm (keeps the local SSO credential server's token hot so
    // PagerDuty investigations never pay the puppeteer-login cost mid-incident).
    // SSO_PREWARM_PROFILES is a CSV — single profile today, multiple later.
    ssoPrewarmEnabled: (process.env.SSO_PREWARM_ENABLED || '').toLowerCase() === 'true',
    ssoPrewarmUrl: process.env.SSO_PREWARM_URL || 'http://localhost:6789',
    ssoPrewarmProfiles: (process.env.SSO_PREWARM_PROFILES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ssoPrewarmIntervalMs: parseInt(process.env.SSO_PREWARM_INTERVAL_MS) || 1800000, // 30 min
    ssoPrewarmTimeoutMs: parseInt(process.env.SSO_PREWARM_TIMEOUT_MS) || 120000, // 2 min. (Briefly tried 10s on 2026-05-26 to "fail fast" past the broken headless-login, but measured `/credentials` latency for legit cached responses is 20-40s due to serial socat handling + repeated aws shell-outs in serve-credentials.sh. 10s would alert false-positive. Revisit if serve-credentials.sh is ever profiled and sped up.)
    // BigQuery auth health monitor. Unlike SSO there's no auto-reseed —
    // `gcloud auth login` is interactive — so this only detects the expiry and
    // DMs the owner to refresh, instead of it silently surfacing mid-incident.
    bqHealthEnabled: (process.env.BQ_HEALTH_ENABLED || '').toLowerCase() === 'true',
    bqHealthCommand: process.env.BQ_HEALTH_COMMAND || 'bq',
    bqHealthIntervalMs: parseInt(process.env.BQ_HEALTH_INTERVAL_MS) || 1800000, // 30 min
    bqHealthTimeoutMs: parseInt(process.env.BQ_HEALTH_TIMEOUT_MS) || 60000, // 1 min
};

// Validate configuration
if (!config.botToken) {
    logger.error('SLACK_BOT_TOKEN must be set in .env file');
    process.exit(1);
}

if (!config.appToken) {
    logger.error('SLACK_APP_TOKEN must be set in .env file (starts with xapp-)');
    process.exit(1);
}

const handler = new SlackSocketHandler(config);

function scheduleDailyRestart(hour) {
    function msUntilNextOccurrence() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(hour, 0, 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target - now;
    }

    function scheduleNext() {
        const ms = msUntilNextOccurrence();
        const hours = (ms / 3600000).toFixed(1);
        logger.info(`Daily restart scheduled at ${hour}:00 (in ${hours}h)`);
        setTimeout(async () => {
            logger.info('Daily restart triggered — restarting Bolt app...');
            const MAX_RETRIES = 3;
            const RETRY_DELAY_MS = 5000;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await handler.stop();
                    await handler.start();
                    logger.info('Daily restart completed successfully');
                    break;
                } catch (err) {
                    logger.error(`Daily restart attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
                    if (attempt === MAX_RETRIES) {
                        logger.error('All restart attempts failed — exiting process');
                        process.exit(1);
                    }
                    logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }
            scheduleNext();
        }, ms);
    }

    scheduleNext();
}

function scheduleDailySummary(time) {
    const channels = parseChannelsConfig(config.dailySummaryChannels);
    if (channels.length === 0) return;

    const [hh, mm] = time.split(':').map(Number);

    function msUntilNextOccurrence() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target - now;
    }

    function scheduleNext() {
        const ms = msUntilNextOccurrence();
        const hours = (ms / 3600000).toFixed(1);
        logger.info(`Daily summary scheduled at ${time} (in ${hours}h) for: ${channels.map(c => c.name).join(', ')}`);
        setTimeout(async () => {
            logger.info('Daily summary triggered');
            try {
                await runDailySummary({
                    channels,
                    ownerUserId: config.ownerUserId,
                    model: config.dailySummaryModel,
                    xoxcToken: config.xoxcToken,
                    xoxdToken: config.xoxdToken,
                    slackClient: handler.app.client,
                    deliveryChannelId: config.channelId,
                });
            } catch (err) {
                logger.error(`Daily summary failed: ${err.message}`);
            }
            scheduleNext();
        }, ms).unref();
    }

    scheduleNext();
}

async function start() {
    logger.info('Starting Slack Socket Mode server...');
    logger.info('Configuration:');
    logger.info(`- Repo Path: ${config.repoPath}`);
    logger.info(`- Repo Root: ${config.repoRoot || 'Not set'}`);
    logger.info(`- Claude Command: ${config.claudeCommand}`);
    logger.info(`- Channel ID: ${config.channelId || 'Any'}`);
    logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None'}`);
    logger.info(`- Allowed Subteams: ${config.allowedSubteams.length > 0 ? config.allowedSubteams.join(', ') : 'None'}`);
    logger.info(`- Access control: ${(config.allowedSubteams.length > 0 || config.whitelist.length > 0) ? 'ENFORCED (owner + team only)' : 'OFF (all authorized)'}`);
    logger.info(`- HTTP Port: ${config.httpPort}`);
    logger.info(`- Monitor Channels: ${config.monitorChannels || 'None'}`);
    logger.info(`- Alert Skill: ${config.alertSkill || 'None'}`);
    logger.info(`- Alert CLI chain: ${config.alertCliChain.join(' → ')}`);
    logger.info(`- Alert Max Concurrent: ${config.alertMaxConcurrent}`);
    logger.info(`- PagerDuty: ${config.pagerdutyApiToken ? 'Configured' : 'Not configured'}`);
    logger.info(`- Session Inactivity Timeout: ${config.sessionInactivityTimeoutMs}ms`);
    logger.info(`- Inflight Heartbeat: ${config.inflightHeartbeatMs}ms`);
    logger.info(`- Poller Timeout: ${config.pollerTimeoutMs}ms`);
    logger.info(`- Poller No-Progress Stall: ${config.pollerNoProgressMs}ms`);
    logger.info(`- Delay Monitor Channels: ${config.monitorDelayChannels || 'None'}`);
    logger.info(`- Delay Alert Skill: ${config.delayAlertSkill}`);
    logger.info(`- Delay Alert CLI chain: ${config.delayAlertCliChain.join(' → ')}`);
    logger.info(`- Delay Alert Threshold: ${config.delayAlertThreshold} alerts in ${config.delayAlertWindowMs}ms`);
    logger.info(`- Daily Summary: ${config.dailySummaryChannels ? `${config.dailySummaryTime} → ${config.dailySummaryChannels}` : 'Not configured'}`);
    logger.info(`- App Mode: ${config.appMode}`);
    logger.info(`- SSO Pre-warm: ${config.ssoPrewarmEnabled ? `${config.ssoPrewarmProfiles.join(', ')} every ${config.ssoPrewarmIntervalMs}ms via ${config.ssoPrewarmUrl}` : 'Disabled'}`);
    logger.info(`- BQ Health Monitor: ${config.bqHealthEnabled ? `every ${config.bqHealthIntervalMs}ms (timeout ${config.bqHealthTimeoutMs}ms)` : 'Disabled'}`);

    // MCP slack-ask: wire Bolt action/view handlers BEFORE socket connect so
    // we don't miss button taps that arrive during the start window.
    // No-op unless MCP_ENABLED=true.
    const mcpEnabled = process.env.MCP_ENABLED === 'true';
    if (mcpEnabled) {
        mcp.wireSlackInteractions(handler.app);
    }

    await handler.start();
    logger.info('Slack Socket Mode is running. Listening for messages...');

    // Pre-warm @mention access control so the first mention isn't slowed by a
    // cold subteam lookup, and so a missing `usergroups:read` scope surfaces at
    // boot (fail-closed = owner-only) instead of silently locking out the team.
    if (handler.accessControl && handler.accessControl.enforced) {
        try {
            await handler.accessControl.refresh();
            const count = (await handler.accessControl._getMembers()).size;
            if (count === 0) {
                logger.warn('Access control ENFORCED but resolved 0 subteam members — likely missing `usergroups:read` scope on the bot token. Only the owner can talk until fixed.');
                if (config.ownerUserId) {
                    await handler.app.client.chat.postMessage({
                        channel: config.ownerUserId,
                        text: ':warning: EnzoBot access control is ON but I resolved *0* team members from the allowed subteams. The bot token probably lacks the `usergroups:read` scope, so right now *only you* can talk to me. Add the scope + reinstall the app, then restart.',
                    }).catch(() => {});
                }
            } else {
                logger.info(`Access control pre-warmed: ${count} team member(s) allowed (plus owner).`);
            }
        } catch (err) {
            logger.warn(`Access control pre-warm failed: ${err.message}`);
        }
    }

    // MCP slack-ask: bring up the HTTP server now that handler.app + handler.db
    // are live. Same env gate — silent no-op when disabled.
    if (mcpEnabled) {
        try {
            const { url } = await mcp.startMcpServer({
                config,
                // Use a getter so daily restarts (handler.stop/start replace
                // this.db) don't leave the MCP server holding a closed handle.
                getDb: () => handler.db,
                slackApp: handler.app,
            });
            if (url) logger.info(`MCP slack-ask server: ${url}/<sessionId>`);
        } catch (err) {
            logger.error(`MCP slack-ask server failed to start: ${err.message}`);
        }
    }

    // Schedule daily restart if configured
    const restartHour = parseInt(process.env.DAILY_RESTART_HOUR);
    if (!isNaN(restartHour) && restartHour >= 0 && restartHour <= 23) {
        scheduleDailyRestart(restartHour);
    }

    // Schedule daily summary if configured (skip in local mode)
    if (config.dailySummaryChannels && config.appMode !== 'local') {
        scheduleDailySummary(config.dailySummaryTime);
    }

    // SSO pre-warm — only on instances that handle PD alerts (cloud/all).
    // Skip on local instances since alerts there don't run AWS investigations.
    if (
        config.ssoPrewarmEnabled
        && config.ssoPrewarmProfiles.length > 0
        && config.appMode !== 'local'
    ) {
        const prewarm = new SsoPrewarm({
            url: config.ssoPrewarmUrl,
            profiles: config.ssoPrewarmProfiles,
            intervalMs: config.ssoPrewarmIntervalMs,
            timeoutMs: config.ssoPrewarmTimeoutMs,
            slackClient: handler.app.client,
            ownerUserId: config.ownerUserId,
        });
        handler.ssoPrewarm = prewarm;
        prewarm.start();
    } else if (config.ssoPrewarmEnabled && config.appMode === 'local') {
        logger.info('SSO pre-warm skipped: APP_MODE=local does not handle alerts');
    }

    // BQ health monitor — same gating as SSO pre-warm: only instances that run
    // investigations (cloud/all) query BigQuery, and gating to one instance
    // avoids duplicate owner DMs when local + cloud run on the same Slack app.
    if (config.bqHealthEnabled && config.appMode !== 'local') {
        const bqHealth = new BqHealthMonitor({
            bqCommand: config.bqHealthCommand,
            intervalMs: config.bqHealthIntervalMs,
            timeoutMs: config.bqHealthTimeoutMs,
            slackClient: handler.app.client,
            ownerUserId: config.ownerUserId,
        });
        handler.bqHealth = bqHealth;
        bqHealth.start();
    } else if (config.bqHealthEnabled && config.appMode === 'local') {
        logger.info('BQ health monitor skipped: APP_MODE=local does not run investigations');
    }
}

start().catch((error) => {
    logger.error('Failed to start Slack Socket Mode:', error.message);
    process.exit(1);
});

// Handle graceful shutdown
function shutdown() {
    logger.info('Shutting down Slack Socket Mode server...');
    if (handler.ssoPrewarm) handler.ssoPrewarm.stop();
    if (handler.bqHealth) handler.bqHealth.stop();
    Promise.resolve()
        .then(() => mcp.stopMcpServer())
        .catch((err) => logger.warn(`mcp stop failed: ${err.message}`))
        .then(() => handler.stop())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Track last log time per rejection reason to avoid log spam
const _rejectionLogTimes = new Map();
const REJECTION_LOG_INTERVAL = 60000; // 1 min

// WebSocket-specific error patterns to feed into the resilience tracker
const WS_ERROR_PATTERNS = [
    'WebSocket was closed before the connection was established',
    'no active connection',
    'client is not ready',
    'Failed to send a WebSocket message',
    'Failed to send a message as the client',
];

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const now = Date.now();
    const lastLogged = _rejectionLogTimes.get(msg) || 0;
    if (now - lastLogged >= REJECTION_LOG_INTERVAL) {
        _rejectionLogTimes.set(msg, now);
        logger.error(`Unhandled rejection: ${msg}`);
    }

    // Feed WebSocket-specific rejections into the handler's error tracker
    if (WS_ERROR_PATTERNS.some(pattern => msg.includes(pattern))) {
        if (handler && handler._recordWsError) {
            handler._recordWsError('unhandled_rejection', msg);
        }
    }
});
