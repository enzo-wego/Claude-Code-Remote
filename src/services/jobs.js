/**
 * Jobs — sleep-proof VPS→Mac work queue. The Mac runner polls /runner/lease;
 * a lease is a soft lock (lease_id + TTL): if the Mac dies mid-job the row
 * becomes claimable again and attempts increments. 3 attempts → failed.
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

class Jobs {
    constructor(db) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key   TEXT,
                kind         TEXT NOT NULL,
                target       TEXT NOT NULL DEFAULT 'mac',
                payload_json TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                lease_id     TEXT,
                leased_at    INTEGER,
                lease_ttl_ms INTEGER,
                attempts     INTEGER NOT NULL DEFAULT 0,
                result_json  TEXT,
                error        TEXT,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            )
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, target)');
        this._s = {
            liveByKey: db.prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('pending','leased')"),
            insert: db.prepare(`
                INSERT INTO jobs (dedupe_key, kind, target, payload_json, created_at, updated_at)
                VALUES (@dedupe_key, @kind, @target, @payload_json, @now, @now)
            `),
            claimable: db.prepare(`
                SELECT * FROM jobs WHERE target = ? AND (
                    status = 'pending' OR
                    (status = 'leased' AND leased_at + lease_ttl_ms < ?)
                ) ORDER BY created_at ASC LIMIT 1
            `),
            claim: db.prepare(`
                UPDATE jobs SET status='leased', lease_id=@lease_id, leased_at=@now,
                    lease_ttl_ms=@ttl, attempts=attempts+1, updated_at=@now
                WHERE id=@id AND (
                    status='pending' OR
                    (status='leased' AND leased_at + lease_ttl_ms < @now)
                )
            `),
            complete: db.prepare(`
                UPDATE jobs SET status='done', result_json=@result, updated_at=@now
                WHERE id=@id AND lease_id=@lease_id AND status='leased'
            `),
            failTerminal: db.prepare(`
                UPDATE jobs SET status='failed', error=@error, updated_at=@now
                WHERE id=@id AND lease_id=@lease_id AND status='leased'
            `),
            failRetry: db.prepare(`
                UPDATE jobs SET status='pending', lease_id=NULL, error=@error, updated_at=@now
                WHERE id=@id AND lease_id=@lease_id AND status='leased'
            `),
            get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
            recent: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?'),
        };
    }

    enqueue(kind, payload, { target = 'mac', dedupeKey = null } = {}) {
        if (dedupeKey && this._s.liveByKey.get(dedupeKey)) return null;
        const info = this._s.insert.run({
            dedupe_key: dedupeKey,
            kind,
            target,
            payload_json: JSON.stringify(payload),
            now: Date.now(),
        });
        return this._s.get.get(info.lastInsertRowid);
    }

    lease(target, { ttlMs = DEFAULT_TTL_MS } = {}) {
        const row = this._s.claimable.get(target, Date.now());
        if (!row) return null;
        const lease_id = crypto.randomUUID();
        const result = this._s.claim.run({
            id: row.id,
            lease_id,
            now: Date.now(),
            ttl: ttlMs,
        });
        if (result.changes === 0) return null;
        return this._s.get.get(row.id);
    }

    complete(id, leaseId, result) {
        return this._s.complete.run({
            id,
            lease_id: leaseId,
            result: JSON.stringify(result),
            now: Date.now(),
        }).changes > 0;
    }

    fail(id, leaseId, error) {
        const row = this._s.get.get(id);
        if (!row) return false;
        const statement = row.attempts >= MAX_ATTEMPTS
            ? this._s.failTerminal
            : this._s.failRetry;
        return statement.run({
            id,
            lease_id: leaseId,
            error: String(error).slice(0, 2000),
            now: Date.now(),
        }).changes > 0;
    }

    get(id) {
        return this._s.get.get(id);
    }

    recent(limit = 50) {
        return this._s.recent.all(limit);
    }
}

module.exports = Jobs;
