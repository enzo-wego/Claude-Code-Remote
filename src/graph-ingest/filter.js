'use strict';

/**
 * T06: Message filter — channel allowlist + subtype skip + bot-self check.
 *
 * shouldIngest(event, config) -> boolean | { pass: boolean, metadata?: object }
 */

const DEFAULT_SKIP_SUBTYPES = new Set([
    'channel_join',
    'channel_leave',
    'message_replied',
    'bot_message',
]);

/**
 * Determine whether a Slack message event should be ingested.
 *
 * Returns one of:
 *   { pass: false }                        — drop the event
 *   { pass: true, metadata: {...} }        — accept with optional extra metadata
 */
function shouldIngest(event, { allowedChannels, skipSubtypes, enzoBotUserId } = {}) {
    const allowed = new Set(allowedChannels || []);
    const skip = new Set([...DEFAULT_SKIP_SUBTYPES, ...(skipSubtypes || [])]);
    const selfId = enzoBotUserId || process.env.ENZOBOT_USER_ID;

    // 1. Channel allowlist ("*" = allow all channels the bot is in)
    if (!allowed.has("*") && !allowed.has(event.channel)) {
        return { pass: false };
    }

    // 2. Bot-self filter (by user ID or bot_id)
    if (selfId && (event.user === selfId || event.bot_id === selfId)) {
        return { pass: false };
    }

    // 3. message_changed: pass with edit metadata
    if (event.subtype === 'message_changed') {
        const editedTs = event.message?.edited?.ts || null;
        return {
            pass: true,
            metadata: {
                subtype: 'message_changed',
                edited: true,
                body_ts: editedTs,
            },
        };
    }

    // 4. message_deleted: pass with delete metadata
    if (event.subtype === 'message_deleted') {
        return {
            pass: true,
            metadata: {
                subtype: 'message_deleted',
                deleted: true,
            },
        };
    }

    // 5. Skip subtypes in the skip list
    if (event.subtype && skip.has(event.subtype)) {
        return { pass: false };
    }

    // 6. Accept
    return { pass: true, metadata: null };
}

module.exports = { shouldIngest };
