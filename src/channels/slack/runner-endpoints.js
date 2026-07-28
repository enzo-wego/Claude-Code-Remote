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
    // `jobs` may be a thunk. The daily restart closes the SQLite handle and
    // _initDb() builds a new Jobs instance; a handler that captured the old one
    // would keep running prepared statements bound to a closed connection.
    const getJobs = typeof jobs === 'function' ? jobs : () => jobs;

    // Express 4 ignores a rejected promise from an async handler, so a throw in
    // here leaves the request hanging with no response instead of failing. The
    // Mac runner polls with no fetch timeout, so one hang stops it permanently —
    // always answer, even when the answer is 500.
    const guard = handler => async (req, res) => {
        if (!tokenOk(req, token)) {
            return res.status(401).json({ error: 'bad token' });
        }
        try {
            return await handler(req, res);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    };

    return {
        lease: guard(async (req, res) => {
            const job = getJobs().lease((req.body && req.body.target) || 'mac');
            return res.json({ job: job || null });
        }),

        complete: guard(async (req, res) => {
            const { job_id, lease_id, result } = req.body || {};
            const ok = getJobs().complete(job_id, lease_id, result || {});
            if (ok && onResult) await onResult(getJobs().get(job_id));
            return res.json({ ok });
        }),

        fail: guard(async (req, res) => {
            const { job_id, lease_id, error } = req.body || {};
            return res.json({
                ok: getJobs().fail(job_id, lease_id, error || 'unknown'),
            });
        }),

        enqueue: guard(async (req, res) => {
            const { kind, payload, dedupe_key, target } = req.body || {};
            if (!kind || !payload) {
                return res.status(400).json({
                    error: 'kind and payload required',
                });
            }
            const row = getJobs().enqueue(kind, payload, {
                dedupeKey: dedupe_key || null,
                target: target || 'mac',
            });
            return res.json({ job: row, deduped: row === null });
        }),
    };
}

module.exports = { makeRunnerHandlers };
