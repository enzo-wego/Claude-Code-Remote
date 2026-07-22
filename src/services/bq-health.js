/**
 * BigQuery Auth Health Monitor
 *
 * The bot runs `bq` queries during investigations (PagerDuty alerts, @mention
 * chat) using the host gcloud user credential (`enzo@wego.com`). That
 * credential's refresh token expires periodically, after which every `bq`
 * call fails with:
 *
 *   Reauthentication failed. cannot prompt during non-interactive execution.
 *   Please run: gcloud auth login
 *
 * Unlike the AWS SSO path (see src/services/sso-prewarm.js), there is NO
 * server-side auto-recovery: `gcloud auth login` is an interactive OAuth flow
 * that a human must run on the VPS. So this watcher cannot re-seed — it can
 * only *detect* the expiry and DM the owner to refresh, instead of the failure
 * silently surfacing mid-incident as a buried "note for Enzo" (as happened on
 * 2026-07-21, payment p9y0yhtbd5).
 *
 * It runs the cheapest possible authenticated query (`SELECT 1`, scans 0 bytes
 * = free) on a fixed interval. On failure it schedules one quick retry; only
 * if that also fails does it DM SLACK_OWNER_USER_ID — a single transient blip
 * the next tick would absorb stays silent. Exactly one ⚠️ per outage streak,
 * re-nagged every REDM_AFTER_MS while it persists (the fix needs a human, so a
 * periodic reminder is warranted), and one ✅ when a query succeeds again.
 */

const { execFile } = require('child_process');
const Logger = require('../core/logger');

const RETRY_AFTER_FAILURE_MS = 30000;
// Re-DM every 2h while BQ stays broken. The fix (gcloud auth login) needs a
// human at a terminal, so a gentle recurring nag is appropriate — but far less
// aggressive than the SSO 11min device-code cadence, since there's no expiring
// URL to chase, just a standing "please log in".
const REDM_AFTER_MS = 2 * 60 * 60 * 1000;

class BqHealthMonitor {
    constructor({ bqCommand, checkArgs, intervalMs, timeoutMs, slackClient, ownerUserId }) {
        this.logger = new Logger('BqHealth');
        this.bqCommand = bqCommand || 'bq';
        this.checkArgs = Array.isArray(checkArgs) && checkArgs.length
            ? checkArgs.slice()
            : ['query', '--use_legacy_sql=false', '--max_rows=1', 'SELECT 1 AS ok'];
        this.intervalMs = intervalMs;
        this.timeoutMs = timeoutMs;
        this.slackClient = slackClient;
        this.ownerUserId = ownerUserId;

        this._timer = null;
        this._retryTimer = null;
        this._inFlight = false;
        this._startedAt = null;
        // Rolling outage state — mirrors SsoPrewarm so we send exactly one ⚠️
        // per streak (re-nagged on REDM_AFTER_MS) and one ✅ on recovery.
        this._consecutiveFailures = 0;
        this._notifiedFailure = false;
        this._notifiedAt = null;
        this._lastOkAt = null;
        this._lastError = null;
    }

    start() {
        if (this._timer) return;
        this._startedAt = Date.now();
        this.logger.info(
            `BQ health monitor starting: interval=${this.intervalMs}ms ` +
            `timeout=${this.timeoutMs}ms cmd="${this.bqCommand} ${this.checkArgs.join(' ')}"`
        );
        // First check 10s after boot so the rest of the bot is up.
        setTimeout(() => { this._tick().catch(() => {}); }, 10000);
        this._timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    }

    getStatus() {
        return {
            enabled: true,
            intervalMs: this.intervalMs,
            timeoutMs: this.timeoutMs,
            uptimeSec: this._startedAt ? Math.round((Date.now() - this._startedAt) / 1000) : 0,
            inFlight: this._inFlight,
            consecutiveFailures: this._consecutiveFailures,
            notifiedFailure: this._notifiedFailure,
            lastOkAt: this._lastOkAt,
            lastError: this._lastError,
        };
    }

    async checkOnce() {
        await this._tick();
        return this.getStatus();
    }

    async _tick() {
        if (this._inFlight) {
            this.logger.debug('BQ health: previous check still in flight, skipping');
            return;
        }
        this._inFlight = true;
        try {
            await this._runCheck();
        } finally {
            this._inFlight = false;
        }
    }

    async _runCheck() {
        const started = Date.now();
        try {
            await this._execBq();
            const duration = Date.now() - started;
            const prevFailures = this._consecutiveFailures;
            const wasNotified = this._notifiedFailure;
            this._consecutiveFailures = 0;
            this._notifiedFailure = false;
            this._notifiedAt = null;
            this._lastOkAt = new Date().toISOString();
            this._lastError = null;
            if (this._retryTimer) {
                clearTimeout(this._retryTimer);
                this._retryTimer = null;
            }
            this.logger.debug(`BQ health OK (${duration}ms)`);
            if (wasNotified) await this._notifyRecovered(prevFailures);
        } catch (err) {
            const duration = Date.now() - started;
            this._lastError = err.message;
            this._consecutiveFailures += 1;
            this.logger.warn(`BQ health FAIL (${duration}ms): ${err.message}`);
            if (this._consecutiveFailures === 1) {
                // Might be a transient network/quota blip. One quick retry
                // before waking the owner; if it recovers, stay silent.
                if (!this._retryTimer) {
                    this._retryTimer = setTimeout(() => {
                        this._retryTimer = null;
                        this._runCheck().catch(() => {});
                    }, RETRY_AFTER_FAILURE_MS);
                    if (this._retryTimer.unref) this._retryTimer.unref();
                }
            } else {
                const sinceLastDm = this._notifiedAt ? (Date.now() - this._notifiedAt) : Infinity;
                if (!this._notifiedFailure || sinceLastDm >= REDM_AFTER_MS) {
                    this._notifiedFailure = true;
                    this._notifiedAt = Date.now();
                    await this._notifyFailure(err.message);
                }
            }
        }
    }

    _execBq() {
        return new Promise((resolve, reject) => {
            execFile(
                this.bqCommand,
                this.checkArgs,
                { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    if (error) {
                        // Prefer stderr — bq puts the "Reauthentication failed…
                        // run gcloud auth login" message there.
                        const detail = (stderr || stdout || error.message || '')
                            .toString().trim().split('\n').slice(0, 4).join(' ');
                        return reject(new Error(detail || `bq exited ${error.code}`));
                    }
                    resolve((stdout || '').toString());
                }
            );
        });
    }

    // True when the failure is the gcloud credential expiring (needs an
    // interactive `gcloud auth login`), as opposed to a transient network /
    // quota / service error. Drives the wording of the DM.
    _isAuthExpiry(errMsg) {
        return /Reauthentication failed|gcloud auth login|credentials|invalid_grant|Reauthentication required|token has expired|refresh/i
            .test(errMsg);
    }

    async _notifyFailure(errMsg) {
        if (!this.ownerUserId || !this.slackClient) return;
        const authExpiry = this._isAuthExpiry(errMsg);
        const lines = [];
        if (authExpiry) {
            lines.push(':warning: *BigQuery auth expired — needs `gcloud auth application-default login`*');
            lines.push('_BQ now authenticates via ADC (see /usr/local/bin/bq shim). The bot cannot self-recover (login is interactive). BQ-dependent investigations will fail or fall back until refreshed._');
        } else {
            lines.push(':warning: *BigQuery health check failing*');
        }
        lines.push('*Fix:* on the VPS as the bot user, run:');
        lines.push('```gcloud auth application-default login```');
        lines.push(`*Error:* ${errMsg.slice(0, 300)}`);
        const text = lines.join('\n');
        try {
            await this.slackClient.chat.postMessage({
                channel: this.ownerUserId,
                text,
                unfurl_links: false,
            });
        } catch (err) {
            this.logger.error(`Failed to DM owner about BQ health failure: ${err.message}`);
        }
    }

    async _notifyRecovered(prevFailures) {
        if (!this.ownerUserId || !this.slackClient) return;
        const text = [
            ':white_check_mark: *BigQuery auth recovered*',
            `*Previous consecutive failures:* ${prevFailures}`,
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({ channel: this.ownerUserId, text });
        } catch (err) {
            this.logger.error(`Failed to DM owner about BQ health recovery: ${err.message}`);
        }
    }
}

module.exports = { BqHealthMonitor };
