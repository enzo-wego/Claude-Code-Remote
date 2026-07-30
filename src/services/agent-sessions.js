/**
 * The work → session index: which coding session belongs to which piece of work.
 *
 * A feature starts on a ticket, grows a PR, and gets reviewed days later. The
 * session that holds all the context is the one from development — not the
 * newest session in the checkout, which is why `claude --continue` is the wrong
 * handle. So the resume key is recorded against the work itself:
 *
 *     issues (jira | gh_issue) ──< pr_tasks.issue_id
 *            └──< agent_sessions >──┘        (either side may be null)
 *
 * `sessionsFor(prId)` therefore returns sessions attached to the PR *and*
 * sessions attached to the PR's issue: the dev session predates the PR row and
 * is only reachable through the ticket. More than one match is normal and the
 * caller asks the owner which to resume — guessing would compact the wrong
 * conversation, and compaction does not come back.
 */
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const GH_ISSUE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** 'PAY-2266' → jira · 'wego/payments#12' → gh_issue. */
function issueType(key) {
    if (JIRA_KEY.test(key)) return 'jira';
    if (GH_ISSUE.test(key)) return 'gh_issue';
    return null;
}

/** The canonical link for a key, so callers only have to pass the key. */
function issueUrl(key, { jiraBase = process.env.JIRA_BASE_URL || 'https://wegomushi.atlassian.net' } = {}) {
    if (JIRA_KEY.test(key)) return `${jiraBase.replace(/\/$/, '')}/browse/${key}`;
    const gh = key.match(GH_ISSUE);
    return gh ? `https://github.com/${gh[1]}/issues/${gh[2]}` : null;
}

class AgentSessions {
    constructor(db) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                key TEXT NOT NULL,
                url TEXT,
                title TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(type, key)
            )
        `);
        // A session with neither a PR nor an issue is unreachable — nothing
        // could ever look it up again — so the schema refuses it.
        db.exec(`
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                cli TEXT NOT NULL DEFAULT 'claude',
                pr_id INTEGER,
                issue_id INTEGER,
                repo TEXT,
                label TEXT,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER,
                UNIQUE(cli, key),
                CHECK (pr_id IS NOT NULL OR issue_id IS NOT NULL)
            )
        `);
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_sessions_pr ON agent_sessions(pr_id)'
        );
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_sessions_issue ON agent_sessions(issue_id)'
        );

        this._s = {
            insertIssue: db.prepare(`
                INSERT INTO issues (type, key, url, title, created_at, updated_at)
                VALUES (@type, @key, @url, @title, @now, @now)
                ON CONFLICT(type, key) DO UPDATE SET
                    url=COALESCE(excluded.url, issues.url),
                    title=COALESCE(excluded.title, issues.title),
                    updated_at=@now
            `),
            issueByKey: db.prepare('SELECT * FROM issues WHERE type=? AND key=?'),
            issue: db.prepare('SELECT * FROM issues WHERE id=?'),
            issues: db.prepare('SELECT * FROM issues ORDER BY updated_at DESC'),
            // Re-linking the same key just refreshes it: a session is one row,
            // however many times it is announced.
            insertSession: db.prepare(`
                INSERT INTO agent_sessions (
                    key, cli, pr_id, issue_id, repo, label, created_at
                )
                VALUES (@key, @cli, @prId, @issueId, @repo, @label, @now)
                ON CONFLICT(cli, key) DO UPDATE SET
                    pr_id=COALESCE(excluded.pr_id, agent_sessions.pr_id),
                    issue_id=COALESCE(excluded.issue_id, agent_sessions.issue_id),
                    repo=COALESCE(excluded.repo, agent_sessions.repo),
                    label=COALESCE(excluded.label, agent_sessions.label)
            `),
            sessionByKey: db.prepare(
                'SELECT * FROM agent_sessions WHERE cli=? AND key=?'
            ),
            session: db.prepare('SELECT * FROM agent_sessions WHERE id=?'),
            // Directly attached, plus everything attached to the PR's issue.
            forPr: db.prepare(`
                SELECT * FROM agent_sessions
                WHERE pr_id = @prId
                   OR (issue_id IS NOT NULL AND issue_id = (
                        SELECT issue_id FROM pr_tasks WHERE id = @prId
                   ))
                ORDER BY COALESCE(last_used_at, created_at) DESC
            `),
            forIssue: db.prepare(`
                SELECT * FROM agent_sessions
                WHERE issue_id = ?
                ORDER BY COALESCE(last_used_at, created_at) DESC
            `),
            touch: db.prepare(
                'UPDATE agent_sessions SET last_used_at=? WHERE id=?'
            ),
            drop: db.prepare('DELETE FROM agent_sessions WHERE id=?'),
        };
    }

    /** Upsert by (type, key); type and url are derived when not given. */
    upsertIssue({ key, type = null, url = null, title = null }) {
        const derived = issueType(key);
        if (!derived) {
            throw new Error(
                `unrecognized issue key '${key}' `
                + '(expected PAY-123 or owner/repo#4)'
            );
        }
        if (type && type !== derived) {
            throw new Error(
                `issue type '${type}' does not match key '${key}'`
            );
        }
        const resolved = type || derived;
        this._s.insertIssue.run({
            type: resolved,
            key,
            url: url || issueUrl(key),
            title,
            now: Date.now(),
        });
        return this._s.issueByKey.get(resolved, key);
    }

    issue(id) {
        return this._s.issue.get(id);
    }

    issueByKey(key, type = null) {
        return this._s.issueByKey.get(type || issueType(key), key);
    }

    listIssues() {
        return this._s.issues.all();
    }

    /** Record a resumable session against a PR, an issue, or both. */
    add({ key, cli = 'claude', prId = null, issueId = null, repo = null, label = null }) {
        if (!key) throw new Error('a session needs a resume key');
        if (prId === null && issueId === null) {
            throw new Error('a session must attach to a PR or an issue');
        }
        this._s.insertSession.run({
            key, cli, prId, issueId, repo, label, now: Date.now(),
        });
        return this._s.sessionByKey.get(cli, key);
    }

    get(id) {
        return this._s.session.get(id);
    }

    /**
     * Candidates for resuming work on a PR, newest use first. Empty means
     * start fresh; more than one means ask.
     */
    sessionsFor(prId) {
        return this._s.forPr.all({ prId });
    }

    sessionsForIssue(issueId) {
        return this._s.forIssue.all(issueId);
    }

    /** Called when a session is actually resumed, so ordering reflects use. */
    touch(id) {
        this._s.touch.run(Date.now(), id);
    }

    remove(id) {
        this._s.drop.run(id);
    }
}

module.exports = AgentSessions;
module.exports.issueType = issueType;
module.exports.issueUrl = issueUrl;
