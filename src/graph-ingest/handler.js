'use strict';

/**
 * T10: Glue — filter → normalize → buffer.
 * T14: Edit handling (subtype=message_changed).
 * T15: Delete handling (subtype=message_deleted).
 * T16: File attachments in metadata payload.
 * T17: Bot author handling (bot_id → ref="bot:<botname>").
 *
 * handle(event, client, { cache, buffer, config, logger }) -> Promise<void>
 * Target: < 5 ms (filter + buffer only; forwarder runs in background drain loop).
 */

const { shouldIngest } = require('./filter');
const { normalize } = require('./normalizer');
const { loadConfig } = require('./config-loader');

/**
 * Build the canonical Slack permalink from team + channel + ts.
 * Format: https://<team>.slack.com/archives/<channel>/p<ts_no_dot>
 */
function buildCanonicalUrl(channelId, ts, teamDomain) {
    const tsDotless = ts.replace('.', '');
    const domain = teamDomain || process.env.SLACK_TEAM_DOMAIN || 'wego';
    return `https://${domain}.slack.com/archives/${channelId}/p${tsDotless}`;
}

/**
 * Build the ingest payload for agent-mem POST /api/graph/ingest/content.
 */
function buildPayload(event, normalizedBody, mentions, links, filterMeta, cache) {
    // Determine the "real" event (message_changed has the real message in event.message)
    const isChanged = event.subtype === 'message_changed';
    const isDeleted = event.subtype === 'message_deleted';
    const realEvent = isChanged ? (event.message || event) : event;

    const channelId = event.channel;
    const ts = isDeleted ? (event.deleted_ts || (event.previous_message && event.previous_message.ts) || event.ts) : (realEvent.ts || event.ts);
    const threadTs = realEvent.thread_ts || null;
    const canonicalUrl = buildCanonicalUrl(channelId, ts);

    // Author resolution
    let authorRef, authorDisplayName, authorIsBot;
    if (realEvent.bot_id) {
        // Bot author: use bot_id + username if available
        const botName = realEvent.username || realEvent.bot_id;
        authorRef = `bot:${botName}`;
        authorDisplayName = botName;
        authorIsBot = true;
    } else if (realEvent.user) {
        const uid = realEvent.user;
        const userMeta = cache ? cache.getUserMeta(uid) : null;
        const displayName = cache ? cache.getUser(uid) : uid;
        authorRef = `slack_uid:${uid}`;
        authorDisplayName = displayName;
        authorIsBot = userMeta ? userMeta.is_bot : false;
    } else {
        authorRef = 'unknown';
        authorDisplayName = 'unknown';
        authorIsBot = false;
    }

    // Files (T16)
    const files = (realEvent.files || []).map(f => ({
        id: f.id,
        mimetype: f.mimetype || null,
        filename: f.name || f.filename || null,
        size: f.size || null,
        url_private: f.url_private || null,
        thumb_360: f.thumb_360 || null,
    }));

    const baseMeta = {
        author: {
            ref: authorRef,
            display_name: authorDisplayName,
            is_bot: authorIsBot,
        },
        mentions,
        ts,
        body_ts: new Date(parseFloat(ts) * 1000).toISOString(),
        channel_id: channelId,
        thread_ts: threadTs,
        subtype: filterMeta?.subtype || event.subtype || null,
        edited: filterMeta?.edited || false,
        deleted: filterMeta?.deleted || false,
        files,
        scope: `slack:${channelId}`,
    };

    return {
        source: 'slack',
        canonical_url: canonicalUrl,
        body: isDeleted ? '' : normalizedBody,
        metadata: baseMeta,
    };
}

/**
 * Main entry point called per Slack message event.
 *
 * @param {Object} event - Slack message event
 * @param {Object} client - Slack WebClient (unused in hot path, available for future use)
 * @param {Object} deps - { cache, buffer, logger }
 */
async function handle(event, client, { cache, buffer, logger } = {}) {
    const log = logger || { debug: () => {}, warn: () => {}, info: () => {} };

    // Load config once
    const cfg = loadConfig();
    const slackCfg = cfg.slack || {};
    const allowedChannels = slackCfg.allowed_channels || [];
    const skipSubtypes = slackCfg.skip_subtypes || [];

    // Filter
    const filterResult = shouldIngest(event, {
        allowedChannels,
        skipSubtypes,
        enzoBotUserId: process.env.ENZOBOT_USER_ID,
    });

    if (!filterResult.pass) {
        log.debug(`graph-ingest: dropping event channel=${event.channel} subtype=${event.subtype || 'none'}`);
        return;
    }

    // Normalize
    let normalized;
    try {
        normalized = await normalize(event, cache);
    } catch (err) {
        log.warn(`graph-ingest: normalize failed: ${err.message}`);
        normalized = { body: event.text || '', mentions: [], links: [] };
    }

    // Build payload
    const payload = buildPayload(
        event,
        normalized.body,
        normalized.mentions,
        normalized.links,
        filterResult.metadata,
        cache
    );

    // Append to buffer (fire-and-forget from caller's perspective; this is sync)
    if (buffer) {
        try {
            buffer.append(payload);
        } catch (err) {
            log.warn(`graph-ingest: buffer append failed: ${err.message}`);
        }
    }
}

module.exports = { handle, buildPayload, buildCanonicalUrl };
