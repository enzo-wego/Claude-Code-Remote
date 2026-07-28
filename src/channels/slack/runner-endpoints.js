/**
 * HTTP handlers the Mac runner calls. Auth: constant-time compare on
 * X-Runner-Token. onResult(jobRow) fires after a successful complete so
 * socket.js can DM the owner.
 */
const crypto = require('crypto');

function tokenOk(req, token) {
    const got = req.headers['x-runner-token'] || '';
    const actual = Buffer.from(String(got));
    const expected = Buffer.from(String(token));
    return Boolean(token)
        && actual.length === expected.length
        && crypto.timingSafeEqual(actual, expected);
}

function makeRunnerHandlers({ jobs, token, onResult }) {
    return {
        async lease(req, res) {
            if (!tokenOk(req, token)) {
                return res.status(401).json({ error: 'bad token' });
            }
            const job = jobs.lease((req.body && req.body.target) || 'mac');
            return res.json({ job: job || null });
        },

        async complete(req, res) {
            if (!tokenOk(req, token)) {
                return res.status(401).json({ error: 'bad token' });
            }
            const { job_id, lease_id, result } = req.body || {};
            const ok = jobs.complete(job_id, lease_id, result || {});
            if (ok && onResult) await onResult(jobs.get(job_id));
            return res.json({ ok });
        },

        async fail(req, res) {
            if (!tokenOk(req, token)) {
                return res.status(401).json({ error: 'bad token' });
            }
            const { job_id, lease_id, error } = req.body || {};
            return res.json({
                ok: jobs.fail(job_id, lease_id, error || 'unknown'),
            });
        },

        async enqueue(req, res) {
            if (!tokenOk(req, token)) {
                return res.status(401).json({ error: 'bad token' });
            }
            const { kind, payload, dedupe_key, target } = req.body || {};
            if (!kind || !payload) {
                return res.status(400).json({
                    error: 'kind and payload required',
                });
            }
            const row = jobs.enqueue(kind, payload, {
                dedupeKey: dedupe_key || null,
                target: target || 'mac',
            });
            return res.json({ job: row, deduped: row === null });
        },
    };
}

module.exports = { makeRunnerHandlers };
