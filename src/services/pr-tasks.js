/**
 * PRs EnzoBot is tracking, in two lanes:
 *   lane='review' — someone is waiting on you.  detected → needs_review →
 *                   reviewing → drafted → posted | dismissed | closed
 *   lane='mine'   — you are waiting on someone else. Status stays 'detected'
 *                   until it merges/closes; the interesting state is
 *                   review_decision + the seen_comments watermark.
 * Origin: slack | github-sweep | github-mine. reviewReady() drives nudges and
 * auto-review, and is deliberately scoped to the review lane.
 */
class PrTasks {
    constructor(db) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS pr_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo TEXT NOT NULL,
                number INTEGER NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                author TEXT,
                ci TEXT DEFAULT 'unknown',
                review_state TEXT DEFAULT 'unknown',
                status TEXT NOT NULL DEFAULT 'detected',
                origin TEXT DEFAULT 'slack',
                draft_job_id INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(repo, number)
            )
        `);
        // Added after the review lane shipped; existing DBs need them bolted on.
        // seen_comments stays NULL on purpose — NULL means "never counted", which
        // is how refreshMine() avoids announcing every PR on its first sweep.
        this._addColumn('lane', "TEXT NOT NULL DEFAULT 'review'");
        this._addColumn('review_decision', 'TEXT');
        this._addColumn('decision_by', 'TEXT');
        this._addColumn('seen_comments', 'INTEGER');

        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_tasks(status)'
        );
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_pr_lane ON pr_tasks(lane, status)'
        );
        this._s = {
            insert: db.prepare(`
                INSERT INTO pr_tasks (
                    repo, number, url, title, author, ci, review_state,
                    origin, lane, created_at, updated_at
                )
                VALUES (
                    @repo, @number, @url, @title, @author, @ci,
                    @review_state, @origin, @lane, @now, @now
                )
                ON CONFLICT(repo, number) DO UPDATE SET
                    url=excluded.url,
                    title=COALESCE(excluded.title, pr_tasks.title),
                    author=COALESCE(excluded.author, pr_tasks.author),
                    ci=CASE
                        WHEN excluded.ci!='unknown' THEN excluded.ci
                        ELSE pr_tasks.ci
                    END,
                    review_state=CASE
                        WHEN excluded.review_state!='unknown'
                            THEN excluded.review_state
                        ELSE pr_tasks.review_state
                    END,
                    lane=excluded.lane,
                    updated_at=@now
            `),
            byKey: db.prepare(
                'SELECT * FROM pr_tasks WHERE repo=? AND number=?'
            ),
            get: db.prepare('SELECT * FROM pr_tasks WHERE id=?'),
            listActive: db.prepare(`
                SELECT * FROM pr_tasks
                WHERE status NOT IN ('posted','dismissed','closed')
                ORDER BY updated_at DESC
            `),
            listActiveLane: db.prepare(`
                SELECT * FROM pr_tasks
                WHERE status NOT IN ('posted','dismissed','closed')
                    AND lane=?
                ORDER BY updated_at DESC
            `),
            reviewReady: db.prepare(`
                SELECT * FROM pr_tasks
                WHERE lane='review'
                    AND ci='green'
                    AND review_state='requested'
                    AND status IN ('detected','needs_review')
            `),
            setStatus: db.prepare(
                'UPDATE pr_tasks SET status=?, updated_at=? WHERE id=?'
            ),
            setMineState: db.prepare(`
                UPDATE pr_tasks
                SET review_decision=@decision,
                    decision_by=@decisionBy,
                    seen_comments=@seenComments,
                    updated_at=@now
                WHERE id=@id
            `),
            setDraftJob: db.prepare(`
                UPDATE pr_tasks
                SET draft_job_id=?, status=?, updated_at=?
                WHERE id=?
            `),
        };
    }

    _addColumn(name, definition) {
        const exists = this.db
            .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?')
            .get('pr_tasks', name);
        if (!exists) {
            this.db.exec(`ALTER TABLE pr_tasks ADD COLUMN ${name} ${definition}`);
        }
    }

    upsert(task) {
        this._s.insert.run({
            repo: task.repo,
            number: task.number,
            url: task.url,
            title: task.title || null,
            author: task.author || null,
            ci: task.ci || 'unknown',
            review_state: task.reviewState || 'unknown',
            origin: task.origin || 'slack',
            lane: task.lane || 'review',
            now: Date.now(),
        });
        return this._s.byKey.get(task.repo, task.number);
    }

    get(id) {
        return this._s.get.get(id);
    }

    /** All active rows, or just one lane's. */
    listActive(lane) {
        return lane
            ? this._s.listActiveLane.all(lane)
            : this._s.listActive.all();
    }

    reviewReady() {
        return this._s.reviewReady.all();
    }

    setStatus(id, status) {
        this._s.setStatus.run(status, Date.now(), id);
    }

    setMineState(id, { reviewDecision = null, decisionBy = null, seenComments = null }) {
        this._s.setMineState.run({
            id,
            decision: reviewDecision,
            decisionBy,
            seenComments,
            now: Date.now(),
        });
    }

    setDraftJob(id, jobId) {
        this._s.setDraftJob.run(jobId, 'reviewing', Date.now(), id);
    }
}

module.exports = PrTasks;
