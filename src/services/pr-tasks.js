/**
 * PRs EnzoBot is tracking, in three lanes:
 *   lane='review' — someone is waiting on you.  detected → needs_review →
 *                   reviewing → drafted → posted | dismissed | closed
 *   lane='mine'   — you are waiting on someone else. Status stays 'detected'
 *                   until it merges/closes; the interesting state is
 *                   review_decision + the seen_comments watermark.
 *   lane='team'   — a teammate's open PR, for awareness. Nobody has asked you
 *                   for anything; you can pull it in with Review now.
 * Precedence when a PR qualifies for more than one: mine > review > team.
 * Origin: slack | github-sweep | github-mine | github-team. reviewReady()
 * drives nudges and auto-review, scoped to the review lane only.
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
        // When GitHub says the PR was opened — not when we first saw it. Drives
        // the age column and the oldest-first ordering of the team lane.
        this._addColumn('pr_created_at', 'INTEGER');
        // Draft PRs are usually noise on a review board — half of these rows
        // were drafts — so they are recorded and filtered at render time rather
        // than dropped, letting the toggle show them without a re-sweep.
        this._addColumn('is_draft', 'INTEGER DEFAULT 0');
        // Whose move it is: 'mine' | 'theirs' | 'done'. Decided by who spoke
        // last, and the only thing the row's glyph shows — CI and review state
        // described the PR, which was never the question being asked.
        this._addColumn('turn', 'TEXT');
        // Live, unresolved review threads where somebody else spoke last.
        // NULL means the GraphQL lookup has not succeeded, not zero.
        this._addColumn('open_threads', 'INTEGER');
        // The ticket this PR implements (issues.id). The link matters because
        // the coding session worth resuming was opened against the ticket,
        // before this row existed — see services/agent-sessions.js.
        this._addColumn('issue_id', 'INTEGER');
        // The DM thread where every message about this PR lands, and the
        // permalink to it. Both NULL until the bot first has something to say —
        // a PR nobody has spoken about has no thread to link to, which is why
        // the menu entry is conditional rather than always present.
        this._addColumn('slack_ts', 'TEXT');
        this._addColumn('slack_permalink', 'TEXT');

        // Board preferences (draft visibility, and whatever the page grows
        // next). One row per key; the board belongs to one owner.
        db.exec(`
            CREATE TABLE IF NOT EXISTS board_prefs (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);

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
                    origin, lane, pr_created_at, is_draft, created_at,
                    updated_at
                )
                VALUES (
                    @repo, @number, @url, @title, @author, @ci,
                    @review_state, @origin, @lane, @pr_created_at, @is_draft,
                    @now, @now
                )
                ON CONFLICT(repo, number) DO UPDATE SET
                    url=excluded.url,
                    title=COALESCE(excluded.title, pr_tasks.title),
                    author=COALESCE(excluded.author, pr_tasks.author),
                    pr_created_at=COALESCE(
                        excluded.pr_created_at, pr_tasks.pr_created_at
                    ),
                    is_draft=COALESCE(excluded.is_draft, pr_tasks.is_draft),
                    ci=CASE
                        WHEN excluded.ci!='unknown' THEN excluded.ci
                        ELSE pr_tasks.ci
                    END,
                    review_state=CASE
                        WHEN excluded.review_state!='unknown'
                            THEN excluded.review_state
                        ELSE pr_tasks.review_state
                    END,
                    -- Lane precedence: mine > review > team. A PR can satisfy
                    -- more than one sweep (your own PR that also requests your
                    -- team; a teammate's PR that requests you), so the stronger
                    -- claim wins regardless of which sweep ran last.
                    lane=CASE
                        WHEN (CASE excluded.lane
                                WHEN 'mine' THEN 0 WHEN 'review' THEN 1 ELSE 2 END)
                          <= (CASE pr_tasks.lane
                                WHEN 'mine' THEN 0 WHEN 'review' THEN 1 ELSE 2 END)
                        THEN excluded.lane
                        ELSE pr_tasks.lane
                    END,
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
            // Decision without the comment watermark: the review/team lanes want
            // "has anyone approved this" but must not touch seen_comments, which
            // only the mine lane maintains.
            setDecision: db.prepare(`
                UPDATE pr_tasks
                SET review_decision=?, decision_by=?, updated_at=?
                WHERE id=?
            `),
            setTurn: db.prepare(
                'UPDATE pr_tasks SET turn=?, updated_at=? WHERE id=?'
            ),
            setOpenThreads: db.prepare(
                'UPDATE pr_tasks SET open_threads=?, updated_at=? WHERE id=?'
            ),
            setIssue: db.prepare(
                'UPDATE pr_tasks SET issue_id=?, updated_at=? WHERE id=?'
            ),
            setSlackThread: db.prepare(`
                UPDATE pr_tasks
                SET slack_ts=?, slack_permalink=?, updated_at=?
                WHERE id=?
            `),
            getPref: db.prepare('SELECT value FROM board_prefs WHERE key=?'),
            setPref: db.prepare(`
                INSERT INTO board_prefs (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
            `),
            setDraftJob: db.prepare(`
                UPDATE pr_tasks
                SET draft_job_id=?, status=?, updated_at=?
                WHERE id=?
            `),
            // A review that died leaves the row stuck at 'reviewing' with no
            // button. Put it back where it was so it can be retried.
            failDraft: db.prepare(`
                UPDATE pr_tasks
                SET draft_job_id=NULL, status='detected', updated_at=?
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
            pr_created_at: task.prCreatedAt || null,
            is_draft: task.isDraft === undefined || task.isDraft === null
                ? null
                : Number(Boolean(task.isDraft)),
            now: Date.now(),
        });
        return this._s.byKey.get(task.repo, task.number);
    }

    get(id) {
        return this._s.get.get(id);
    }

    byRepoNumber(repo, number) {
        return this._s.byKey.get(repo, number);
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

    /** Board preference, string-valued. */
    getPref(key, fallback = null) {
        const row = this._s.getPref.get(key);
        return row ? row.value : fallback;
    }

    setPref(key, value) {
        this._s.setPref.run(key, String(value));
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

    setDecision(id, { reviewDecision = null, decisionBy = null }) {
        this._s.setDecision.run(reviewDecision, decisionBy, Date.now(), id);
    }

    setTurn(id, turn) {
        this._s.setTurn.run(turn || null, Date.now(), id);
    }

    setOpenThreads(id, count) {
        this._s.setOpenThreads.run(count, Date.now(), id);
    }

    setIssue(id, issueId) {
        this._s.setIssue.run(issueId || null, Date.now(), id);
    }

    setSlackThread(id, ts, permalink) {
        this._s.setSlackThread.run(ts, permalink, Date.now(), id);
    }

    setDraftJob(id, jobId) {
        this._s.setDraftJob.run(jobId, 'reviewing', Date.now(), id);
    }

    failDraft(id) {
        this._s.failDraft.run(Date.now(), id);
    }
}

module.exports = PrTasks;
