/**
 * Posts an "@<L1> please double-check" follow-up message under an alert
 * investigation's final report. Best-effort: any failure (PD API down,
 * no on-call configured, Slack lookup miss) falls back to mentioning the
 * configured owner. Never throws — must not break the report flow.
 *
 * Slack user IDs are cached in `pd_slack_user_cache` so we only hit
 * `users.lookupByEmail` once per ~30 days per teammate.
 */

const axios = require('axios');
const Database = require('better-sqlite3');

const PD_BASE = 'https://api.pagerduty.com';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DOUBLE_CHECK_TEXT = 'final report above, AI can make mistakes, help to double-check';

function pdHeaders(token) {
    return {
        Authorization: `Token token=${token}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
    };
}

function ensureCacheTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS pd_slack_user_cache (
        pd_email      TEXT PRIMARY KEY,
        slack_user_id TEXT,
        slack_name    TEXT,
        looked_up_at  INTEGER NOT NULL,
        not_found     INTEGER NOT NULL DEFAULT 0
    )`);
}

function readIncidentIdFromQueue(db, channelId, alertMessageTs) {
    const row = db.prepare(
        'SELECT incident_id FROM alert_queue WHERE channel_id = ? AND message_ts = ? ORDER BY id DESC LIMIT 1'
    ).get(channelId, alertMessageTs);
    return row?.incident_id || null;
}

async function getEscalationPolicyId(incidentId, token) {
    const res = await axios.get(`${PD_BASE}/incidents/${incidentId}`, {
        headers: pdHeaders(token),
        timeout: 10_000,
    });
    return res.data?.incident?.escalation_policy?.id || null;
}

async function getL1Email(escalationPolicyId, token) {
    const res = await axios.get(`${PD_BASE}/oncalls`, {
        headers: pdHeaders(token),
        params: {
            'escalation_policy_ids[]': escalationPolicyId,
            'include[]': 'users',
        },
        timeout: 10_000,
    });
    // PD ignores escalation_level filter when escalation_policy_ids is set,
    // so we filter client-side.
    const oncalls = res.data?.oncalls || [];
    const l1 = oncalls.find(o => o.escalation_level === 1);
    return l1?.user?.email || null;
}

async function resolveSlackUserId({ email, web, db, ttlMs = CACHE_TTL_MS }) {
    ensureCacheTable(db);
    const row = db.prepare('SELECT * FROM pd_slack_user_cache WHERE pd_email = ?').get(email);
    const now = Date.now();
    if (row && (now - row.looked_up_at) < ttlMs) {
        return row.not_found ? null : row.slack_user_id;
    }
    let slackUserId = null;
    let slackName = null;
    let notFound = 0;
    try {
        const apiRes = await web.users.lookupByEmail({ email });
        slackUserId = apiRes?.user?.id || null;
        slackName = apiRes?.user?.real_name || apiRes?.user?.name || null;
    } catch (err) {
        if (err?.data?.error === 'users_not_found') {
            notFound = 1;
        } else {
            throw err;
        }
    }
    db.prepare(
        'INSERT INTO pd_slack_user_cache (pd_email, slack_user_id, slack_name, looked_up_at, not_found) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(pd_email) DO UPDATE SET slack_user_id = excluded.slack_user_id, slack_name = excluded.slack_name, looked_up_at = excluded.looked_up_at, not_found = excluded.not_found'
    ).run(email, slackUserId, slackName, now, notFound);
    return notFound ? null : slackUserId;
}

async function postOncallDoubleCheck({
    web,
    dbPath,
    channelId,
    threadTs,
    alertMessageTs,
    pagerdutyApiToken,
    ownerUserId,
    logger = console,
}) {
    if (!channelId || !threadTs) return;

    let mention = ownerUserId ? `<@${ownerUserId}>` : null;
    let db = null;

    try {
        db = new Database(dbPath);
        if (!pagerdutyApiToken) throw new Error('PAGERDUTY_API_TOKEN not configured');
        if (!alertMessageTs) throw new Error('alertMessageTs missing');

        const incidentId = readIncidentIdFromQueue(db, channelId, alertMessageTs);
        if (!incidentId) throw new Error('no incident_id in alert_queue');

        const epId = await getEscalationPolicyId(incidentId, pagerdutyApiToken);
        if (!epId) throw new Error(`no escalation_policy on incident ${incidentId}`);

        const email = await getL1Email(epId, pagerdutyApiToken);
        if (!email) throw new Error(`no L1 oncall for escalation_policy ${epId}`);

        const slackUserId = await resolveSlackUserId({ email, web, db });
        if (slackUserId) {
            mention = `<@${slackUserId}>`;
        } else {
            (logger.warn || logger.error || console.error)(`Oncall: Slack lookup miss for ${email}; falling back to owner`);
        }
    } catch (err) {
        (logger.error || console.error)(`Oncall lookup failed: ${err.message}; falling back to owner`);
    } finally {
        try { db?.close(); } catch (_) { /* ignore */ }
    }

    if (!mention) {
        (logger.warn || logger.error || console.error)('Oncall: no L1 mention and no SLACK_OWNER_USER_ID; skipping double-check ping');
        return;
    }

    try {
        await web.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `${mention} ${DOUBLE_CHECK_TEXT}`,
        });
    } catch (err) {
        (logger.error || console.error)(`Failed to post double-check ping: ${err.message}`);
    }
}

module.exports = {
    postOncallDoubleCheck,
    resolveSlackUserId,
    ensureCacheTable,
    DOUBLE_CHECK_TEXT,
};
