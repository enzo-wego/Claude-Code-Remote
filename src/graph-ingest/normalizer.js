'use strict';

/**
 * T04: Slack markup → plain text normalization.
 * T05: Mentions extraction.
 *
 * Mirrors the rules in agent-mem/internal/graph/normalizer/slack.go.
 *
 * async normalize(event, cache) -> { body, mentions, links }
 *   body     - plain-text string, embedding-friendly
 *   mentions - [{ ref, display_name }]
 *   links    - [{ url, display_text }]
 */

// Matches all <...> Slack tokens
const SLACK_TOKEN_RE = /<([^>]*)>/g;

const BOLD_RE = /\*([^*]+)\*/g;
// Italic: only strip _word_ at word boundaries to avoid mangling URL params
const ITALIC_RE = /(?:^|[\s(,])_([^_\s][^_]*)_(?=$|[\s),.:;!?])/gm;
const STRIKE_RE = /~([^~]+)~/g;

/**
 * Normalize a Slack message event to plain text.
 *
 * @param {Object} event - Slack message event (or event.message for message_changed)
 * @param {Object} cache - NameCache instance
 * @returns {{ body: string, mentions: Array, links: Array }}
 */
async function normalize(event, cache) {
    // For message_changed, the actual text lives in event.message
    const raw = (event.subtype === 'message_changed')
        ? (event.message?.text || '')
        : (event.text || '');

    const mentions = [];
    const links = [];

    // --- Step 1: Replace all <...> Slack tokens ---
    let text = raw.replace(SLACK_TOKEN_RE, (match, inner) => {
        // User mention: <@Uxxxxxx> or <@Uxxxxxx|name>
        if (inner.startsWith('@U') || inner.startsWith('@W')) {
            const id = inner.slice(1).split('|')[0]; // strip leading @
            const display_name = cache ? cache.getUser(id) : id;
            mentions.push({ ref: `slack_uid:${id}`, display_name });
            return `@${display_name}`;
        }

        // Channel: <#Cxxxxxx> or <#Cxxxxxx|name>
        if (inner.startsWith('#')) {
            const rest = inner.slice(1);
            const pipeIdx = rest.indexOf('|');
            if (pipeIdx !== -1 && rest.slice(pipeIdx + 1)) {
                return `#${rest.slice(pipeIdx + 1)}`;
            }
            const id = pipeIdx !== -1 ? rest.slice(0, pipeIdx) : rest;
            const name = cache ? cache.getChannel(id) : id;
            return `#${name}`;
        }

        // Subteam: <!subteam^SID|handle>
        if (inner.startsWith('!subteam^')) {
            const rest = inner.slice('!subteam^'.length);
            const pipeIdx = rest.indexOf('|');
            let id, label;
            if (pipeIdx !== -1) {
                id = rest.slice(0, pipeIdx);
                label = rest.slice(pipeIdx + 1).replace(/^@/, '');
            } else {
                id = rest;
                label = id;
            }
            mentions.push({ ref: `slack_group:${id}`, display_name: label });
            return `@${label}`;
        }

        // Broadcasts
        if (inner === '!here') return '@here';
        if (inner === '!channel') return '@channel';
        if (inner === '!everyone') return '@everyone';

        // URL: <http://...> or <http://...|label>
        if (inner.startsWith('http://') || inner.startsWith('https://')) {
            const lastPipe = inner.lastIndexOf('|');
            if (lastPipe !== -1) {
                const url = inner.slice(0, lastPipe);
                const label = inner.slice(lastPipe + 1);
                links.push({ url, display_text: label });
                return `${label} (${url})`;
            }
            links.push({ url: inner, display_text: inner });
            return inner;
        }

        // Unknown token: emit inner as-is
        return inner;
    });

    // --- Step 2: Strip Slack formatting wrappers ---
    text = stripSlackFormatting(text);

    // --- Step 3: HTML entity unescape (LAST, so encoded brackets aren't re-parsed) ---
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

    return { body: text, mentions, links };
}

function stripSlackFormatting(text) {
    // *bold* → bold
    text = text.replace(BOLD_RE, '$1');

    // _italic_ → italic (only at word boundaries)
    text = text.replace(ITALIC_RE, (match, content) => {
        // Preserve the surrounding context character (space/punct before/after)
        const leading = match[0] !== '_' ? match[0] : '';
        const trailing = match[match.length - 1] !== '_' ? match[match.length - 1] : '';
        return leading + content + trailing;
    });

    // ~strike~ → strike
    text = text.replace(STRIKE_RE, '$1');

    return text;
}

module.exports = { normalize, stripSlackFormatting };
