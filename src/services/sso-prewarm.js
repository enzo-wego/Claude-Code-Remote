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
 * On failure (timeout, HTTP error, server down) the watcher schedules a
 * single quick retry. Only if that retry also fails does it DM
 * SLACK_OWNER_USER_ID — single transient timeouts that the next tick
 * would have absorbed stay silent. The retry exists because a real
 * outage during quiet hours otherwise hides for the full poll interval
 * (typically 30 min) before we hear about it.
 */

const RETRY_AFTER_FAILURE_MS = 30000;
// Re-DM the operator with a fresh device-code URL every ~11min while the
// outage persists. AWS device-code URLs expire after 10min, so silence past
// that point would leave the operator tapping a dead link. Aligns with the
// /admin/reseed reuse window in get-credentials-lib.sh.
const REDM_AFTER_MS = 11 * 60 * 1000;
// Preemptive re-seed times. Bot host is UTC; these are 08:00 + 20:00 GMT+7
// (= 01:00 + 13:00 UTC). Hits both natural hinge points of the day — morning
// startup and pre-sleep — so the role-cred TTL never expires mid-workday.
const SCHEDULED_RESEED_UTC_HOURS = [1, 13];
const ADMIN_RESEED_TIMEOUT_MS = 15000;
// Fast-poll cadence after a failure DM: hammer /credentials every 10s so the
// operator gets a ✅ recovery DM within ~10s of tapping the URL instead of
// waiting up to one full prewarm cycle (30min).
const FAST_POLL_INTERVAL_MS = 10000;
const FAST_POLL_MAX_MS = 11 * 60 * 1000;

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
        // Per-profile rolling state. notifiedFailure tracks whether we've
        // already DM'd about the current outage so we send exactly one ⚠️
        // per streak and one ✅ on recovery — and stay silent when a
        // single failure is self-covered by the scheduled retry.
        this._state = new Map();
        for (const p of this.profiles) {
            this._state.set(p, {
                lastWarmAt: null,
                lastDurationMs: null,
                lastError: null,
                consecutiveFailures: 0,
                credentialExpiresAt: null,
                notifiedFailure: false,
                notifiedAt: null,
                retryTimer: null,
                fastPollTimer: null,
                fastPollStartedAt: null,
            });
        }
        this._scheduledTimer = null;
        this._scheduledApprovalTimer = null;
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
        this._scheduleNextReseed();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._scheduledTimer) {
            clearTimeout(this._scheduledTimer);
            this._scheduledTimer = null;
        }
        if (this._scheduledApprovalTimer) {
            clearInterval(this._scheduledApprovalTimer);
            this._scheduledApprovalTimer = null;
        }
        for (const state of this._state.values()) {
            if (state.retryTimer) {
                clearTimeout(state.retryTimer);
                state.retryTimer = null;
            }
            if (state.fastPollTimer) {
                clearInterval(state.fastPollTimer);
                state.fastPollTimer = null;
            }
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
            const wasNotified = state.notifiedFailure;
            state.consecutiveFailures = 0;
            state.notifiedFailure = false;
            state.notifiedAt = null;
            if (state.fastPollTimer) {
                clearInterval(state.fastPollTimer);
                state.fastPollTimer = null;
                state.fastPollStartedAt = null;
            }
            if (state.retryTimer) {
                clearTimeout(state.retryTimer);
                state.retryTimer = null;
            }
            try {
                const parsed = JSON.parse(body);
                if (parsed.Expiration) state.credentialExpiresAt = parsed.Expiration;
            } catch { /* non-JSON shape (e.g. shell export) — ignore */ }
            this.logger.debug(`SSO pre-warm OK: ${profile} (${duration}ms)`);
            if (wasNotified) {
                await this._notifyOwnerRecovered(profile, prevFailures);
            }
        } catch (err) {
            const duration = Date.now() - started;
            state.lastDurationMs = duration;
            state.lastError = err.message;
            state.consecutiveFailures += 1;
            this.logger.warn(`SSO pre-warm FAIL: ${profile} (${duration}ms): ${err.message}`);
            if (state.consecutiveFailures === 1) {
                // Likely the SSO server is mid-login. Schedule one quick
                // retry instead of waking the owner — if it succeeds the
                // outage was self-covered and stays silent.
                if (!state.retryTimer) {
                    state.retryTimer = setTimeout(() => {
                        state.retryTimer = null;
                        this._warmProfile(profile).catch(() => {});
                    }, RETRY_AFTER_FAILURE_MS);
                    if (state.retryTimer.unref) state.retryTimer.unref();
                }
            } else {
                const sinceLastDm = state.notifiedAt ? (Date.now() - state.notifiedAt) : Infinity;
                if (!state.notifiedFailure || sinceLastDm >= REDM_AFTER_MS) {
                    state.notifiedFailure = true;
                    state.notifiedAt = Date.now();
                    await this._notifyOwnerFailure(profile, err.message, duration);
                    this._startFastPoll(profile);
                }
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

        // Only auto-trigger a device-code reseed for AWS-side session expiry.
        // Network errors / timeouts / 4xx are unrelated and would just waste
        // an SSO login attempt.
        const isSsoExpiry = /SSO login failed|Token has expired/i.test(errMsg)
            || /HTTP 500/.test(errMsg);
        let reseed = null;
        if (isSsoExpiry) {
            try {
                reseed = await this._callAdminReseed();
            } catch (err) {
                this.logger.warn(`Failed to trigger /admin/reseed: ${err.message}`);
            }
        }

        const lines = [':warning: *SSO session expired — tap to re-seed*'];
        lines.push(`*Profile:* \`${profile}\``);
        if (reseed && reseed.verification_url) {
            lines.push(`*Approve:* <${reseed.verification_url}|${reseed.verification_url}>`);
            lines.push(`*User code:* \`${reseed.user_code}\``);
            const mins = Math.max(1, Math.round((reseed.expires_in || 600) / 60));
            const reissue = Math.round(REDM_AFTER_MS / 60000);
            lines.push(`_URL valid ~${mins}min. If you miss it, a fresh URL is DM'd every ${reissue}min until you approve._`);
        } else {
            lines.push(`*Duration:* ${durationMs}ms`);
            lines.push(`*Error:* ${errMsg}`);
            lines.push('_Could not auto-trigger device-code re-seed. Check `docker logs sso_server --tail 80`._');
        }
        const text = lines.join('\n');
        try {
            await this.slackClient.chat.postMessage({
                channel: this.ownerUserId,
                text,
                unfurl_links: false,
            });
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

    _callAdminReseed() {
        return new Promise((resolve, reject) => {
            let target;
            try {
                target = new URL(this.url);
            } catch (e) {
                return reject(new Error(`invalid SSO_PREWARM_URL: ${e.message}`));
            }
            target.pathname = '/admin/reseed';
            target.search = '';

            const lib = target.protocol === 'https:' ? https : http;
            const req = lib.get(target, { timeout: ADMIN_RESEED_TIMEOUT_MS }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    let parsed;
                    try { parsed = JSON.parse(body); }
                    catch { return reject(new Error(`/admin/reseed returned non-JSON: ${body.slice(0, 120)}`)); }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`/admin/reseed HTTP ${res.statusCode}: ${parsed.error || body.slice(0, 120)}`));
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error(`/admin/reseed timeout after ${ADMIN_RESEED_TIMEOUT_MS}ms`)));
            req.on('error', reject);
        });
    }

    _scheduleNextReseed() {
        if (this._scheduledTimer) return;
        const now = new Date();
        // Walk forward through today's and tomorrow's slots, pick the soonest future one.
        let next = null;
        for (let dayOffset = 0; dayOffset <= 1 && !next; dayOffset++) {
            for (const hourUtc of SCHEDULED_RESEED_UTC_HOURS) {
                const candidate = new Date(Date.UTC(
                    now.getUTCFullYear(),
                    now.getUTCMonth(),
                    now.getUTCDate() + dayOffset,
                    hourUtc, 0, 0
                ));
                if (candidate > now && (!next || candidate < next)) next = candidate;
            }
        }
        const delayMs = next - now;
        this._scheduledTimer = setTimeout(() => {
            this._scheduledTimer = null;
            this._runScheduledReseed().catch(() => {});
            this._scheduleNextReseed();
        }, delayMs);
        if (this._scheduledTimer.unref) this._scheduledTimer.unref();
        const gmtPlus7Hour = (next.getUTCHours() + 7) % 24;
        this.logger.info(
            `Next scheduled re-seed: ${next.toISOString()} ` +
            `(${Math.round(delayMs / 60000)}min away; ${String(gmtPlus7Hour).padStart(2, '0')}:00 GMT+7)`
        );
    }

    async _runScheduledReseed() {
        if (!this.ownerUserId || !this.slackClient) return;
        let reseed;
        try {
            reseed = await this._callAdminReseed();
        } catch (err) {
            this.logger.error(`Scheduled re-seed: /admin/reseed failed: ${err.message}`);
            return;
        }
        if (!reseed || !reseed.verification_url) {
            this.logger.warn(`Scheduled re-seed: no URL returned (${JSON.stringify(reseed)})`);
            return;
        }
        const mins = Math.max(1, Math.round((reseed.expires_in || 600) / 60));
        // Pick an icon by the GMT+7 hour so it actually reads right ("morning"
        // for 8am, "evening" for 8pm). Bot host is UTC so we add 7.
        const localHour = (new Date().getUTCHours() + 7) % 24;
        const isEvening = localHour >= 17 || localHour < 5;
        const icon = isEvening ? ':crescent_moon:' : ':sunrise:';
        const text = [
            `${icon} *Scheduled SSO re-seed*`,
            `*Approve:* <${reseed.verification_url}|${reseed.verification_url}>`,
            `*User code:* \`${reseed.user_code}\``,
            `_Tap to extend the session for the next ~12h. URL valid ~${mins}min._`,
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({
                channel: this.ownerUserId,
                text,
                unfurl_links: false,
            });
            this.logger.info(`Scheduled re-seed DM sent (reused=${!!reseed.reused})`);
            // Capture the SSO token's expiresAt now so a poller can detect
            // when the user actually approves (expiresAt advances). The
            // existing fast-poll path doesn't help here — /credentials stays
            // 200 the whole time when the session is healthy, so success
            // alone isn't a usable signal for "approval landed."
            const baseline = await this._callReseedStatus().catch(() => null);
            if (baseline && baseline.sso_token_expires_at) {
                this._pollScheduledApproval(baseline.sso_token_expires_at);
            } else {
                this.logger.warn('Scheduled re-seed: no baseline expiresAt, skipping approval poll');
            }
        } catch (err) {
            this.logger.error(`Failed to DM owner about scheduled re-seed: ${err.message}`);
        }
    }

    _callReseedStatus() {
        return new Promise((resolve, reject) => {
            let target;
            try { target = new URL(this.url); }
            catch (e) { return reject(new Error(`invalid SSO_PREWARM_URL: ${e.message}`)); }
            target.pathname = '/admin/reseed/status';
            target.search = '';
            const lib = target.protocol === 'https:' ? https : http;
            const req = lib.get(target, { timeout: ADMIN_RESEED_TIMEOUT_MS }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    try { resolve(JSON.parse(body)); }
                    catch { reject(new Error(`bad JSON from /admin/reseed/status: ${body.slice(0, 120)}`)); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('/admin/reseed/status timeout')));
            req.on('error', reject);
        });
    }

    // Watches for the user to approve a scheduled re-seed. The SSO token
    // file's expiresAt advances when `aws sso login` writes a fresh token,
    // so polling that is a clean signal — distinct from /credentials, which
    // returns 200 the whole time when the existing session is still healthy.
    _pollScheduledApproval(baselineExpiresAt) {
        if (this._scheduledApprovalTimer) clearInterval(this._scheduledApprovalTimer);
        const startedAt = Date.now();
        this._scheduledApprovalTimer = setInterval(async () => {
            if ((Date.now() - startedAt) > FAST_POLL_MAX_MS) {
                clearInterval(this._scheduledApprovalTimer);
                this._scheduledApprovalTimer = null;
                this.logger.debug('Scheduled approval poll: aged out without approval');
                return;
            }
            let status;
            try { status = await this._callReseedStatus(); }
            catch { return; } // transient; keep polling
            if (status && status.sso_token_expires_at
                && status.sso_token_expires_at !== baselineExpiresAt) {
                clearInterval(this._scheduledApprovalTimer);
                this._scheduledApprovalTimer = null;
                await this._notifyScheduledApproved(status.sso_token_expires_at);
            }
        }, FAST_POLL_INTERVAL_MS);
        if (this._scheduledApprovalTimer.unref) this._scheduledApprovalTimer.unref();
    }

    async _notifyScheduledApproved(newExpiresAt) {
        if (!this.ownerUserId || !this.slackClient) return;
        const text = [
            ':white_check_mark: *SSO session extended*',
            `_New SSO token valid until ${newExpiresAt}._`,
            '_Next scheduled DM at 08:00 or 20:00 GMT+7._',
        ].join('\n');
        try {
            await this.slackClient.chat.postMessage({
                channel: this.ownerUserId,
                text,
                unfurl_links: false,
            });
            this.logger.info(`Scheduled approval confirmed DM sent (new expiresAt=${newExpiresAt})`);
        } catch (err) {
            this.logger.error(`Failed to DM owner about scheduled approval: ${err.message}`);
        }
    }

    // Polls /credentials every FAST_POLL_INTERVAL_MS while an outage is open
    // so a successful approval lands a recovery DM within ~10s instead of
    // waiting for the next 30-min prewarm tick. Cancels itself when the
    // regular tick already recovered (state.notifiedFailure reset).
    _startFastPoll(profile) {
        const state = this._state.get(profile);
        if (!state) return;
        if (state.fastPollTimer) return; // already polling
        state.fastPollStartedAt = Date.now();
        state.fastPollTimer = setInterval(async () => {
            // Bailout: outage already cleared by the slow tick, or aged out.
            if (!state.notifiedFailure
                || (Date.now() - state.fastPollStartedAt) > FAST_POLL_MAX_MS) {
                clearInterval(state.fastPollTimer);
                state.fastPollTimer = null;
                state.fastPollStartedAt = null;
                return;
            }
            try {
                await this._fetchCredentials(profile);
            } catch {
                return; // still failing; keep polling
            }
            // Success — drive a full tick through the success path so all the
            // state bookkeeping + recovery DM go through the same code as the
            // 30-min tick. _warmProfile resets fastPollTimer on its way.
            this._warmProfile(profile).catch(() => {});
        }, FAST_POLL_INTERVAL_MS);
        if (state.fastPollTimer.unref) state.fastPollTimer.unref();
    }
}

module.exports = { SsoPrewarm };
