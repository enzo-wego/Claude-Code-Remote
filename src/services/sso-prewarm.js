/**
 * SSO Pre-Warm Service
 *
 * The local SSO credential server (Docker container `sso_server` on
 * 127.0.0.1:6789) mints temporary AWS credentials by exchanging a cached
 * AWS-SSO access token. When that access token expires, the server has to
 * drive a full puppeteer login (~60-90s) before it can respond to
 * `/credentials`. If a PagerDuty alert fires during that window, the
 * Claude investigation tmux ends up waiting on the credential exchange and
 * frequently fails or stalls.
 *
 * This watcher keeps the access token warm: it polls
 * `GET /credentials?profile=<p>&format=json` on a fixed interval. As long
 * as the interval is shorter than the SSO session lifetime, every call
 * returns instantly (token still valid) and the alert path never pays the
 * puppeteer-login cost during an incident.
 *
 * On failure (timeout, HTTP error, server down) the watcher DMs
 * SLACK_OWNER_USER_ID once until recovery so we find out during quiet
 * hours rather than mid-incident.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const Logger = require('../core/logger');

class SsoPrewarm {
    constructor({ url, profiles, intervalMs, timeoutMs, slackClient, ownerUserId }) {
        this.logger = new Logger('SsoPrewarm');
        this.url = url;
        this.profiles = Array.isArray(profiles) ? profiles.slice() : [profiles].filter(Boolean);
        this.intervalMs = intervalMs;
        this.timeoutMs = timeoutMs;
        this.slackClient = slackClient;
        this.ownerUserId = ownerUserId;

        this._timer = null;
        this._inFlight = false;
        this._startedAt = null;
        // Per-profile rolling state. lastNotifiedFailureAt is only used to
        // suppress duplicate "still failing" DMs — a single DM per failure
        // streak, plus one recovery DM, is the right cadence.
        this._state = new Map();
        for (const p of this.profiles) {
            this._state.set(p, {
                lastWarmAt: null,
                lastDurationMs: null,
                lastError: null,
                consecutiveFailures: 0,
                credentialExpiresAt: null,
            });
        }
    }

    start() {
        if (this._timer) return;
        if (this.profiles.length === 0) {
            this.logger.warn('SSO pre-warm not starting: no profiles configured');
            return;
        }
        this._startedAt = Date.now();
        this.logger.info(
            `SSO pre-warm starting: profiles=[${this.profiles.join(', ')}] ` +
            `interval=${this.intervalMs}ms timeout=${this.timeoutMs}ms url=${this.url}`
        );
        // Kick off the first warm 5s after boot so the rest of the bot is up.
        setTimeout(() => { this._tick().catch(() => {}); }, 5000);
        this._timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    getStatus() {
        const perProfile = {};
        for (const [profile, state] of this._state) {
            perProfile[profile] = { ...state };
        }
        return {
            enabled: true,
            url: this.url,
            profiles: this.profiles,
            intervalMs: this.intervalMs,
            timeoutMs: this.timeoutMs,
            uptimeSec: this._startedAt ? Math.round((Date.now() - this._startedAt) / 1000) : 0,
            inFlight: this._inFlight,
            perProfile,
        };
    }

    async warmOnce() {
        await this._tick();
        return this.getStatus();
    }

    async _tick() {
        if (this._inFlight) {
            this.logger.debug('SSO pre-warm: previous tick still in flight, skipping');
            return;
        }
        this._inFlight = true;
        try {
            // Sequential per-profile to avoid hammering the SSO server with
            // simultaneous puppeteer logins if multiple tokens expire at once.
            for (const profile of this.profiles) {
                await this._warmProfile(profile);
            }
        } finally {
            this._inFlight = false;
        }
    }

    async _warmProfile(profile) {
        const state = this._state.get(profile);
        const started = Date.now();
        try {
            const body = await this._fetchCredentials(profile);
            const duration = Date.now() - started;
            state.lastWarmAt = new Date().toISOString();
            state.lastDurationMs = duration;
            state.lastError = null;
            const prevFailures = state.consecutiveFailures;
            state.consecutiveFailures = 0;
            try {
                const parsed = JSON.parse(body);
                if (parsed.Expiration) state.credentialExpiresAt = parsed.Expiration;
            } catch { /* non-JSON shape (e.g. shell export) — ignore */ }
            this.logger.debug(`SSO pre-warm OK: ${profile} (${duration}ms)`);
            if (prevFailures > 0) {
                await this._notifyOwnerRecovered(profile, prevFailures);
            }
        } catch (err) {
            const duration = Date.now() - started;
            state.lastDurationMs = duration;
            state.lastError = err.message;
            state.consecutiveFailures += 1;
            this.logger.warn(`SSO pre-warm FAIL: ${profile} (${duration}ms): ${err.message}`);
            if (state.consecutiveFailures === 1) {
                await this._notifyOwnerFailure(profile, err.message, duration);
            }
        }
    }

    _fetchCredentials(profile) {
        return new Promise((resolve, reject) => {
            let target;
            try {
                target = new URL(this.url);
            } catch (e) {
                return reject(new Error(`invalid SSO_PREWARM_URL: ${e.message}`));
            }
            target.pathname = '/credentials';
            target.searchParams.set('profile', profile);
            target.searchParams.set('format', 'json');

            const lib = target.protocol === 'https:' ? https : http;
            const req = lib.get(target, { timeout: this.timeoutMs }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    }
                });
            });
            req.on('timeout', () => {
                req.destroy(new Error(`timeout after ${this.timeoutMs}ms`));
            });
            req.on('error', reject);
        });
    }

    async _notifyOwnerFailure(profile, errMsg, durationMs) {
        if (!this.ownerUserId || !this.slackClient) return;
        const text = [
            ':warning: *SSO pre-warm failed*',
            `*Profile:* \`${profile}\``,
            `*Duration:* ${durationMs}ms`,
            `*Error:* ${errMsg}`,
            '*Action:* Check `docker logs sso_server --tail 80`. PagerDuty investigations may stall on token refresh until this is resolved.',
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({ channel: this.ownerUserId, text });
        } catch (err) {
            this.logger.error(`Failed to DM owner about SSO pre-warm failure: ${err.message}`);
        }
    }

    async _notifyOwnerRecovered(profile, prevFailures) {
        if (!this.ownerUserId || !this.slackClient) return;
        const text = [
            ':white_check_mark: *SSO pre-warm recovered*',
            `*Profile:* \`${profile}\``,
            `*Previous consecutive failures:* ${prevFailures}`,
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({ channel: this.ownerUserId, text });
        } catch (err) {
            this.logger.error(`Failed to DM owner about SSO pre-warm recovery: ${err.message}`);
        }
    }
}

module.exports = { SsoPrewarm };
