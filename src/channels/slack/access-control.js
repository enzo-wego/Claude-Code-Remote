'use strict';

/**
 * Access control for @mention chat.
 *
 * Two tiers, driven by who sent the message:
 *
 *   - owner  (SLACK_OWNER_USER_ID): full access, including personal + server
 *            / infrastructure info. Alert/queue/delay flows (userId === null,
 *            system-triggered) are treated as owner-level too — they need AWS /
 *            server access to investigate.
 *   - team   (members of SLACK_ALLOWED_SUBTEAMS + any explicit SLACK_WHITELIST
 *            user IDs): may use the bot, but a boundary block is injected that
 *            forbids disclosing the owner's personal info or any server /
 *            infrastructure detail. See restrictionPreamble().
 *   - everyone else: denied.
 *
 * Subteam membership is resolved via `usergroups.users.list` and cached with a
 * TTL. If resolution fails (e.g. the bot token lacks the `usergroups:read`
 * scope) we FAIL CLOSED: only the owner is allowed until the cache can be
 * populated. That honors the "lock it down to my team" intent — a resolution
 * outage must never silently re-open the bot to the whole workspace.
 *
 * Backward-compat: when neither SLACK_ALLOWED_SUBTEAMS nor SLACK_WHITELIST is
 * configured, enforcement is OFF and everyone is allowed with full access
 * (the pre-2026-07 behavior).
 */
class AccessControl {
    /**
     * @param {object}   opts
     * @param {object}   opts.client       Slack WebClient (app.client).
     * @param {string}   opts.ownerUserId  Owner Slack user ID.
     * @param {string[]} opts.allowedSubteams  Subteam (usergroup) IDs, e.g. ['S01…'].
     * @param {string[]} opts.whitelist    Explicit user IDs always allowed as team.
     * @param {object}   [opts.logger]     Logger with info/warn/error.
     * @param {number}   [opts.cacheTtlMs] Subteam-membership cache TTL (default 10 min).
     */
    constructor({ client, ownerUserId, allowedSubteams = [], whitelist = [], logger = console, cacheTtlMs = 600000 } = {}) {
        this.client = client;
        this.ownerUserId = ownerUserId || '';
        this.allowedSubteams = (allowedSubteams || []).filter(Boolean);
        this.explicitWhitelist = new Set((whitelist || []).filter(Boolean));
        this.logger = logger;
        this.cacheTtlMs = cacheTtlMs;

        // Resolved union of all subteam members. null until first successful
        // resolution; an empty Set means "resolved, but no members".
        this._members = null;
        this._membersFetchedAt = 0;
        this._refreshPromise = null; // dedup concurrent refreshes
    }

    /** Enforcement is active only once the owner has locked it down. */
    get enforced() {
        return this.allowedSubteams.length > 0 || this.explicitWhitelist.size > 0;
    }

    isOwner(userId) {
        return !!userId && !!this.ownerUserId && userId === this.ownerUserId;
    }

    /**
     * Can this user talk to the bot at all?
     * Owner always yes. If enforcement is off, everyone yes. Otherwise the user
     * must be explicitly whitelisted or a member of an allowed subteam.
     */
    async isAllowed(userId) {
        if (!this.enforced) return true;
        if (this.isOwner(userId)) return true;
        if (!userId) return false;
        if (this.explicitWhitelist.has(userId)) return true;
        const members = await this._getMembers();
        return members.has(userId);
    }

    /**
     * Should this user's session be restricted (no personal / server info)?
     * True for every allowed non-owner. Owner and system flows (userId null)
     * are unrestricted.
     */
    isRestricted(userId) {
        if (!this.enforced) return false;
        if (!userId) return false;
        return !this.isOwner(userId);
    }

    /** Return the cached member set, refreshing if stale/empty. Never throws. */
    async _getMembers() {
        const fresh = this._members !== null && (Date.now() - this._membersFetchedAt) < this.cacheTtlMs;
        if (fresh) return this._members;
        await this.refresh();
        // On a failed first resolution _members is still null → fail closed.
        return this._members || new Set();
    }

    /**
     * Resolve every allowed subteam's members into a single Set. Deduped across
     * groups. On failure the previous cache is retained (or stays null → owner
     * only). Concurrent callers share one in-flight refresh.
     */
    async refresh() {
        if (this._refreshPromise) return this._refreshPromise;
        this._refreshPromise = this._doRefresh().finally(() => { this._refreshPromise = null; });
        return this._refreshPromise;
    }

    async _doRefresh() {
        if (this.allowedSubteams.length === 0) {
            // Only explicit whitelist in play — nothing to fetch.
            this._members = new Set();
            this._membersFetchedAt = Date.now();
            return this._members;
        }
        const union = new Set();
        let anyFailed = false;
        for (const usergroup of this.allowedSubteams) {
            try {
                const res = await this.client.usergroups.users.list({ usergroup, include_disabled: false });
                if (res && res.ok && Array.isArray(res.users)) {
                    for (const uid of res.users) union.add(uid);
                } else {
                    anyFailed = true;
                    this.logger.warn(`AccessControl: usergroups.users.list returned not-ok for ${usergroup}: ${res && res.error}`);
                }
            } catch (err) {
                anyFailed = true;
                this.logger.error(`AccessControl: failed to resolve subteam ${usergroup}: ${err.message}`);
            }
        }

        if (anyFailed && union.size === 0) {
            // Total resolution failure (e.g. missing usergroups:read scope).
            // Keep whatever we had before; if we never resolved, stay null so
            // isAllowed() fails closed to owner-only.
            this.logger.error('AccessControl: subteam resolution failed entirely — falling back to owner-only until it recovers');
            return this._members || new Set();
        }

        this._members = union;
        this._membersFetchedAt = Date.now();
        this.logger.info(`AccessControl: resolved ${union.size} allowed member(s) across ${this.allowedSubteams.length} subteam(s)`);
        return this._members;
    }

    /**
     * Boundary block injected ahead of a restricted (team, non-owner) user's
     * prompt every turn. It is a standing instruction, not a guarantee — a
     * determined user could still try to talk around it — but it establishes
     * the boundary Enzo asked for: teammates get help with work, never the
     * owner's private data or this server's internals.
     */
    restrictionPreamble() {
        return [
            '[ACCESS BOUNDARY — RESTRICTED USER]',
            'You are talking to a Wego teammate who is NOT the bot owner. Help them with their work-related question ONLY. You MUST NOT reveal, summarize, read out, or act on any of the following, and must politely decline if asked — say it is restricted to the bot owner:',
            "- The owner's personal information: private messages, DMs, personal accounts, saved memories/notes, calendar, or anything not related to the teammate's own work request.",
            '- Server / infrastructure details: hostnames, IP addresses, absolute file paths, directory listings of the host, environment variables, secrets, credentials, tokens, API keys, .env or config file contents, AWS/SSO configuration, systemd/tmux internals, or the source code and internals of this bot itself.',
            '- Running shell commands whose purpose is to read secrets/credentials, dump the environment, or expose the server filesystem.',
            'If a request would reveal any of the above, refuse briefly and explain it is limited to the bot owner. Otherwise, answer normally.',
        ].join('\n');
    }
}

module.exports = { AccessControl };
