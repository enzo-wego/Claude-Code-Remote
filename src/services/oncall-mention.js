/**
 * Posts an "@<L1> please double-check" follow-up message under an alert
 * investigation's final report. Best-effort: any failure (PD API down,
 * no on-call for the policy, email not in our static map) falls back to
 * mentioning the configured owner. Never throws — must not break the
 * report flow.
 *
 * Email → Slack user ID comes from PD_EMAIL_SLACK_MAP in .env. The
 * Slack bot does not have the `users:read.email` scope, so we don't
 * call users.lookupByEmail. Format:
 *   PD_EMAIL_SLACK_MAP=lei@wego.com:UUK3WPNNQ,yanyi@wego.com:U050BBA607M
 * Update the env var when team membership changes; restart the service.
 */

const axios = require('axios');
const Database = require('better-sqlite3');

const PD_BASE = 'https://api.pagerduty.com';
const DOUBLE_CHECK_TEXT = '(L1 PagerDuty on-call for this service) — final report above. AI can make mistakes, please double-check.';

function parsePdEmailMap(envVal) {
    const map = {};
    if (!envVal) return map;
    for (const pair of envVal.split(',')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(':');
        if (idx === -1) {
            console.error(`PD_EMAIL_SLACK_MAP: skipping malformed entry "${trimmed}" (expected "email:slack_user_id")`);
            continue;
        }
        const email = trimmed.substring(0, idx).trim().toLowerCase();
        const slackId = trimmed.substring(idx + 1).trim();
        if (email && slackId) map[email] = slackId;
    }
    return map;
}

function pdHeaders(token) {
    return {
        Authorization: `Token token=${token}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
    };
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

function resolveSlackUserId(email) {
    if (!email) return null;
    const map = parsePdEmailMap(process.env.PD_EMAIL_SLACK_MAP);
    return map[email.toLowerCase()] || null;
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

        const slackUserId = resolveSlackUserId(email);
        if (slackUserId) {
            mention = `<@${slackUserId}>`;
        } else {
            (logger.warn || logger.error || console.error)(`Oncall: ${email} not in PD_EMAIL_TO_SLACK_USER_ID map; falling back to owner`);
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
    parsePdEmailMap,
    DOUBLE_CHECK_TEXT,
};
