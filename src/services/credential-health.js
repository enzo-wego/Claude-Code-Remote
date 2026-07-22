/**
 * Generic Credential Health Monitor
 *
 * Periodically runs a cheap probe command for some external credential
 * (BigQuery via `bq`, Google Workspace via `gws`, …). None of these can
 * self-recover — the fix is an interactive re-login — so this only DETECTS
 * expiry and DMs the owner the correct recovery command, instead of the
 * failure silently surfacing mid-incident.
 *
 * Behaviour mirrors SsoPrewarm's discipline: one quick retry absorbs a
 * transient blip; a sustained failure DMs the owner exactly once per outage
 * streak (re-nagged every `redmAfterMs`), and one ✅ is sent on recovery.
 *
 * Parametrised so one class covers every credential:
 *   name            human label, e.g. "BigQuery" / "Google Workspace (gws)"
 *   command,args    the probe (must exit non-zero when the credential is bad)
 *   recoveryCommand the exact command the owner must run to fix it
 *   recoveryNote    optional extra italic line in the failure DM
 */

const { execFile } = require('child_process');
const Logger = require('../core/logger');

const RETRY_AFTER_FAILURE_MS = 30000;
// Re-DM every 2h while broken. The fix needs a human at a terminal, so a
// gentle recurring nag is appropriate.
const DEFAULT_REDM_AFTER_MS = 2 * 60 * 60 * 1000;

class CredentialHealthMonitor {
    constructor({
        name, command, checkArgs, recoveryCommand, recoveryNote,
        intervalMs, timeoutMs, redmAfterMs, slackClient, ownerUserId, logName,
    }) {
        this.name = name || 'Credential';
        this.logger = new Logger(logName || 'CredHealth');
        this.command = command;
        this.checkArgs = Array.isArray(checkArgs) ? checkArgs.slice() : [];
        this.recoveryCommand = recoveryCommand || '';
        this.recoveryNote = recoveryNote || '';
        this.intervalMs = intervalMs;
        this.timeoutMs = timeoutMs;
        this.redmAfterMs = redmAfterMs || DEFAULT_REDM_AFTER_MS;
        this.slackClient = slackClient;
        this.ownerUserId = ownerUserId;

        this._timer = null;
        this._retryTimer = null;
        this._inFlight = false;
        this._startedAt = null;
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
            `${this.name} health monitor starting: interval=${this.intervalMs}ms ` +
            `timeout=${this.timeoutMs}ms cmd="${this.command} ${this.checkArgs.join(' ')}"`
        );
        // First check 10s after boot so the rest of the bot is up.
        setTimeout(() => { this._tick().catch(() => {}); }, 10000);
        this._timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    }

    getStatus() {
        return {
            name: this.name,
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
            this.logger.debug(`${this.name} health: previous check still in flight, skipping`);
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
            await this._exec();
            const duration = Date.now() - started;
            const prevFailures = this._consecutiveFailures;
            const wasNotified = this._notifiedFailure;
            this._consecutiveFailures = 0;
            this._notifiedFailure = false;
            this._notifiedAt = null;
            this._lastOkAt = new Date().toISOString();
            this._lastError = null;
            if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
            this.logger.debug(`${this.name} health OK (${duration}ms)`);
            if (wasNotified) await this._notifyRecovered(prevFailures);
        } catch (err) {
            const duration = Date.now() - started;
            this._lastError = err.message;
            this._consecutiveFailures += 1;
            this.logger.warn(`${this.name} health FAIL (${duration}ms): ${err.message}`);
            if (this._consecutiveFailures === 1) {
                // Might be a transient blip. One quick retry before waking the
                // owner; if it recovers, stay silent.
                if (!this._retryTimer) {
                    this._retryTimer = setTimeout(() => {
                        this._retryTimer = null;
                        this._runCheck().catch(() => {});
                    }, RETRY_AFTER_FAILURE_MS);
                    if (this._retryTimer.unref) this._retryTimer.unref();
                }
            } else {
                const sinceLastDm = this._notifiedAt ? (Date.now() - this._notifiedAt) : Infinity;
                if (!this._notifiedFailure || sinceLastDm >= this.redmAfterMs) {
                    this._notifiedFailure = true;
                    this._notifiedAt = Date.now();
                    await this._notifyFailure(err.message);
                }
            }
        }
    }

    _exec() {
        return new Promise((resolve, reject) => {
            execFile(
                this.command, this.checkArgs,
                { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    if (error) {
                        const detail = (stderr || stdout || error.message || '')
                            .toString().trim().split('\n').slice(0, 4).join(' ');
                        return reject(new Error(detail || `${this.command} exited ${error.code}`));
                    }
                    resolve((stdout || '').toString());
                }
            );
        });
    }

    // True when the failure looks like a credential/auth expiry (needs an
    // interactive re-login) vs a transient network/service error. Only tunes
    // the DM header wording — the fix command is included either way.
    _isAuthExpiry(errMsg) {
        return /Reauthentication|gcloud auth|auth login|credentials?|invalid_grant|token has expired|expired|unauthenticated|unauthorized|permission|denied|missing or invalid/i
            .test(errMsg);
    }

    async _notifyFailure(errMsg) {
        if (!this.ownerUserId || !this.slackClient) return;
        const authExpiry = this._isAuthExpiry(errMsg);
        const lines = [];
        if (authExpiry) {
            lines.push(`:warning: *${this.name} auth expired — needs \`${this.recoveryCommand}\`*`);
            if (this.recoveryNote) lines.push(`_${this.recoveryNote}_`);
        } else {
            lines.push(`:warning: *${this.name} health check failing*`);
        }
        lines.push('*Fix:* on the VPS as the bot user, run:');
        lines.push('```' + this.recoveryCommand + '```');
        lines.push(`*Error:* ${errMsg.slice(0, 300)}`);
        try {
            await this.slackClient.chat.postMessage({
                channel: this.ownerUserId, text: lines.join('\n'), unfurl_links: false,
            });
        } catch (err) {
            this.logger.error(`Failed to DM owner about ${this.name} health failure: ${err.message}`);
        }
    }

    async _notifyRecovered(prevFailures) {
        if (!this.ownerUserId || !this.slackClient) return;
        const text = [
            `:white_check_mark: *${this.name} auth recovered*`,
            `*Previous consecutive failures:* ${prevFailures}`,
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({ channel: this.ownerUserId, text });
        } catch (err) {
            this.logger.error(`Failed to DM owner about ${this.name} health recovery: ${err.message}`);
        }
    }
}

module.exports = { CredentialHealthMonitor };
