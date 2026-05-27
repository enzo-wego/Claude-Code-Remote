'use strict';

/**
 * Display-name cache for Slack user IDs and channel IDs.
 * Bootstrap via users.list + conversations.list on startup.
 * Hourly refresh. Persisted to disk so restarts don't need a fresh bulk fetch.
 *
 * T02: bootstrap + lookup
 * T03: hourly refresh + persistence
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.enzobot', 'cache', 'slack-names.json');
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class NameCache {
    constructor({ cachePath } = {}) {
        this.cachePath = cachePath || process.env.GRAPH_INGEST_CACHE_PATH || DEFAULT_CACHE_PATH;
        // Maps: id -> { display_name, email, is_bot, updated_at }
        this.users = new Map();
        // Maps: id -> { name, updated_at }
        this.channels = new Map();
        this._refreshTimer = null;
        this._client = null;
        this._logger = null;
    }

    /**
     * Bootstrap cache from Slack API (users.list + conversations.list) + persist.
     * @param {Object} client - Slack WebClient
     * @param {Object} logger
     */
    async bootstrap(client, logger) {
        this._client = client;
        this._logger = logger;

        // Try loading from disk first
        this._loadFromDisk();

        // Always do a fresh bulk fetch on startup to catch changes
        try {
            await this._bulkFetchUsers(client, logger);
            await this._bulkFetchChannels(client, logger);
            this._saveToDisk();
            logger.info(`graph-ingest cache: bootstrapped ${this.users.size} users, ${this.channels.size} channels`);
        } catch (err) {
            logger.warn(`graph-ingest cache: bootstrap fetch failed (using disk cache): ${err.message}`);
        }

        // Schedule hourly refresh
        this._scheduleRefresh();
    }

    /**
     * Fetch all users via users.list (paginated).
     */
    async _bulkFetchUsers(client, logger) {
        let cursor;
        let count = 0;
        do {
            const params = { limit: 200 };
            if (cursor) params.cursor = cursor;
            const res = await client.users.list(params);
            for (const member of (res.members || [])) {
                const display_name = member.profile?.display_name
                    || member.profile?.real_name
                    || member.name
                    || member.id;
                this.users.set(member.id, {
                    display_name,
                    email: member.profile?.email || null,
                    is_bot: !!(member.is_bot || member.is_app_user),
                    updated_at: Date.now(),
                });
                count++;
            }
            cursor = res.response_metadata?.next_cursor;
        } while (cursor);
        if (logger) logger.info(`graph-ingest cache: fetched ${count} users`);
    }

    /**
     * Fetch all channels via conversations.list (paginated).
     */
    async _bulkFetchChannels(client, logger) {
        let cursor;
        let count = 0;
        do {
            const params = { limit: 200, types: 'public_channel,private_channel', exclude_archived: false };
            if (cursor) params.cursor = cursor;
            const res = await client.conversations.list(params);
            for (const ch of (res.channels || [])) {
                this.channels.set(ch.id, {
                    name: ch.name || ch.id,
                    updated_at: Date.now(),
                });
                count++;
            }
            cursor = res.response_metadata?.next_cursor;
        } while (cursor);
        if (logger) logger.info(`graph-ingest cache: fetched ${count} channels`);
    }

    /**
     * Look up a user's display name. On miss, trigger async backfill.
     * @returns {string} display_name or fallback userId
     */
    getUser(userId) {
        const entry = this.users.get(userId);
        if (entry) return entry.display_name;

        // Cache miss: trigger async backfill if we have a client
        if (this._client) {
            this._backfillUser(userId).catch(() => {});
        }
        return userId; // fallback to raw ID
    }

    /**
     * Look up user metadata (for bot detection etc.)
     */
    getUserMeta(userId) {
        return this.users.get(userId) || null;
    }

    /**
     * Look up a channel's name.
     */
    getChannel(channelId) {
        const entry = this.channels.get(channelId);
        return entry ? entry.name : channelId;
    }

    /**
     * Async single-user backfill on cache miss.
     */
    async _backfillUser(userId) {
        try {
            const res = await this._client.users.info({ user: userId });
            const member = res.user;
            if (!member) return;
            const display_name = member.profile?.display_name
                || member.profile?.real_name
                || member.name
                || member.id;
            this.users.set(member.id, {
                display_name,
                email: member.profile?.email || null,
                is_bot: !!(member.is_bot || member.is_app_user),
                updated_at: Date.now(),
            });
            this._saveToDisk();
            if (this._logger) {
                this._logger.info(`graph-ingest cache: backfilled user ${userId} -> ${display_name}`);
            }
        } catch (err) {
            if (this._logger) {
                this._logger.warn(`graph-ingest cache: backfill failed for ${userId}: ${err.message}`);
            }
        }
    }

    /**
     * Schedule hourly refresh.
     */
    _scheduleRefresh() {
        if (this._refreshTimer) clearInterval(this._refreshTimer);
        this._refreshTimer = setInterval(async () => {
            if (!this._client || !this._logger) return;
            try {
                await this._bulkFetchUsers(this._client, this._logger);
                await this._bulkFetchChannels(this._client, this._logger);
                this._saveToDisk();
                this._logger.info('graph-ingest cache: hourly refresh complete');
            } catch (err) {
                this._logger.warn(`graph-ingest cache: hourly refresh failed: ${err.message}`);
            }
        }, REFRESH_INTERVAL_MS);
        // Don't prevent process exit
        if (this._refreshTimer.unref) this._refreshTimer.unref();
    }

    /**
     * Persist cache to disk.
     */
    _saveToDisk() {
        try {
            const dir = path.dirname(this.cachePath);
            fs.mkdirSync(dir, { recursive: true });
            const data = {
                users: Object.fromEntries(this.users),
                channels: Object.fromEntries(this.channels),
                saved_at: new Date().toISOString(),
            };
            fs.writeFileSync(this.cachePath, JSON.stringify(data), 'utf8');
        } catch (err) {
            if (this._logger) {
                this._logger.warn(`graph-ingest cache: failed to save to disk: ${err.message}`);
            }
        }
    }

    /**
     * Load cache from disk (best-effort, silently skip if missing).
     */
    _loadFromDisk() {
        try {
            if (!fs.existsSync(this.cachePath)) return;
            const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
            if (data.users) {
                for (const [k, v] of Object.entries(data.users)) {
                    this.users.set(k, v);
                }
            }
            if (data.channels) {
                for (const [k, v] of Object.entries(data.channels)) {
                    this.channels.set(k, v);
                }
            }
        } catch (_) {
            // Silently ignore corrupt cache files
        }
    }

    /**
     * Stop background timers.
     */
    stop() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
}

module.exports = { NameCache };
