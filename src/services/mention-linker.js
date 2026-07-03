/**
 * Turn plain-text teammate names in a CLI reply into real Slack `<@ID>` mentions.
 *
 * The CLI writes replies that address people by name ("Surbhi Babbar, staging
 * auth is back…"), but the bot historically pinged only ONE person — the last
 * @mention author, prepended as a single `<@ID>` (see sendResponse in
 * cli-hook-notify.js). So a reply meant for several people notified only one of
 * them. This resolves the *other* people the reply addresses by matching their
 * names against the thread's participants and rewriting the first occurrence of
 * each into a real mention, so everyone the reply talks to actually gets pinged.
 *
 * High precision by design — a mis-ping spams a real coworker:
 *   - only thread participants are candidates (never arbitrary names)
 *   - bots (including this bot) are excluded, so no self-ping loops
 *   - only a full real/display name (containing a space) or an explicit `@handle`
 *     is matched — bare first names are too ambiguous to link safely
 *   - only the FIRST occurrence per person is linked
 *   - a name already written as `<@ID>` or mid-word is never re-linked
 *
 * Best-effort: every Slack call is wrapped so any failure leaves the text
 * untouched and never breaks the post.
 */

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Distinct human participants of a thread, with the names we can match on.
 * Bots and the excluded IDs (typically the person already pinged in the prefix)
 * are dropped. Returns [] on any failure.
 *
 * @returns {Promise<Array<{id, realName, displayName, userName}>>}
 */
async function getThreadParticipants(web, channelId, threadTs, { excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds.filter(Boolean));
    const ids = new Set();
    try {
        const res = await web.conversations.replies({ channel: channelId, ts: threadTs, limit: 200 });
        for (const m of (res.messages || [])) {
            // Skip bot posts and non-message events (joins/leaves carry a subtype).
            if (m.user && !m.bot_id && !m.subtype) ids.add(m.user);
        }
    } catch (err) {
        (console.error)(`mention-linker: replies lookup failed: ${err.message}`);
        return [];
    }

    const participants = [];
    for (const id of ids) {
        if (excluded.has(id)) continue;
        try {
            const info = await web.users.info({ user: id });
            const u = info.user;
            if (!u || u.is_bot || u.id === 'USLACKBOT') continue;
            const profile = u.profile || {};
            participants.push({
                id,
                realName: String(profile.real_name || u.real_name || '').trim(),
                displayName: String(profile.display_name || '').trim(),
                userName: String(u.name || '').trim(),
            });
        } catch (err) {
            // A single unresolved user must not drop the rest.
            (console.error)(`mention-linker: users.info(${id}) failed: ${err.message}`);
        }
    }
    return participants;
}

/**
 * Rewrite the first occurrence of each participant's name in `text` into a
 * `<@ID>` mention. Pure/synchronous — safe to unit test without Slack.
 *
 * @param {string} text
 * @param {Array} participants  from getThreadParticipants
 * @param {{skipIds?: string[]}} opts  IDs already mentioned elsewhere (e.g. the prefix)
 * @returns {{text: string, linkedIds: string[]}}
 */
function linkNamesToMentions(text, participants, { skipIds = [] } = {}) {
    if (!text || !Array.isArray(participants) || participants.length === 0) {
        return { text, linkedIds: [] };
    }
    const skip = new Set(skipIds.filter(Boolean));
    const linkedIds = [];
    let out = text;

    // Longest real name first so "Surbhi Babbar" is tried before a bare "Surbhi",
    // and one person can't steal another's shorter substring.
    const ordered = [...participants].sort(
        (a, b) => (b.realName || '').length - (a.realName || '').length
    );

    for (const p of ordered) {
        if (!p || !p.id || skip.has(p.id) || linkedIds.includes(p.id)) continue;

        // Only high-confidence forms: full names (with a space) and explicit
        // @handles. Bare single-token first names are intentionally NOT matched.
        const candidates = [];
        if (p.realName && p.realName.includes(' ')) candidates.push(p.realName);
        if (p.displayName && p.displayName.includes(' ')) candidates.push(p.displayName);
        if (p.userName) candidates.push('@' + p.userName);

        for (const name of candidates) {
            if (!name) continue;
            // Don't match inside a word or inside an existing <@ID> token.
            const re = new RegExp(`(?<![\\w<@])${escapeRegExp(name)}(?![\\w>])`, 'i');
            if (re.test(out)) {
                out = out.replace(re, `<@${p.id}>`);
                linkedIds.push(p.id);
                break;
            }
        }
    }

    return { text: out, linkedIds };
}

/**
 * Convenience wrapper: fetch participants and link names in one call.
 * `alreadyMentionedId` is the person already pinged in the message prefix; they
 * are neither fetched nor re-linked. Returns the original text on any failure.
 */
async function linkThreadMentions(web, channelId, threadTs, text, alreadyMentionedId = null) {
    if (!text) return { text, linkedIds: [] };
    try {
        const exclude = alreadyMentionedId ? [alreadyMentionedId] : [];
        const participants = await getThreadParticipants(web, channelId, threadTs, { excludeIds: exclude });
        return linkNamesToMentions(text, participants, { skipIds: exclude });
    } catch (err) {
        (console.error)(`mention-linker: linkThreadMentions failed: ${err.message}`);
        return { text, linkedIds: [] };
    }
}

module.exports = {
    getThreadParticipants,
    linkNamesToMentions,
    linkThreadMentions,
    escapeRegExp,
};
