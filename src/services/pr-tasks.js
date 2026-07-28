/**
 * PRs EnzoBot is tracking for review. Status flow:
 *   detected → needs_review → reviewing → drafted → posted | dismissed
 * Origin: slack | github-sweep. reviewReady() drives nudges and auto-review.
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
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_tasks(status)'
        );
        this._s = {
            insert: db.prepare(`
                INSERT INTO pr_tasks (
                    repo, number, url, title, author, ci, review_state,
                    origin, created_at, updated_at
                )
                VALUES (
                    @repo, @number, @url, @title, @author, @ci,
                    @review_state, @origin, @now, @now
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
                    updated_at=@now
            `),
            byKey: db.prepare(
                'SELECT * FROM pr_tasks WHERE repo=? AND number=?'
            ),
            get: db.prepare('SELECT * FROM pr_tasks WHERE id=?'),
            listActive: db.prepare(`
                SELECT * FROM pr_tasks
                WHERE status NOT IN ('posted','dismissed')
                ORDER BY updated_at DESC
            `),
            reviewReady: db.prepare(`
                SELECT * FROM pr_tasks
                WHERE ci='green'
                    AND review_state='requested'
                    AND status IN ('detected','needs_review')
            `),
            setStatus: db.prepare(
                'UPDATE pr_tasks SET status=?, updated_at=? WHERE id=?'
            ),
            setDraftJob: db.prepare(`
                UPDATE pr_tasks
                SET draft_job_id=?, status=?, updated_at=?
                WHERE id=?
            `),
        };
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
            now: Date.now(),
        });
        return this._s.byKey.get(task.repo, task.number);
    }

    get(id) {
        return this._s.get.get(id);
    }

    listActive() {
        return this._s.listActive.all();
    }

    reviewReady() {
        return this._s.reviewReady.all();
    }

    setStatus(id, status) {
        this._s.setStatus.run(status, Date.now(), id);
    }

    setDraftJob(id, jobId) {
        this._s.setDraftJob.run(jobId, 'reviewing', Date.now(), id);
    }
}

module.exports = PrTasks;
