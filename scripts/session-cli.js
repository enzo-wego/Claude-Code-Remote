#!/usr/bin/env node
/**
 * Session CLI — link/inspect coding sessions by PR or issue.
 *   session-cli link --key <uuid> --issue PAY-2266
 *   session-cli list --pr wego/payments#412
 *   session-cli issues
 * DB path: SESSIONS_DB_PATH env, else the bot's slack-sessions.db.
 */
const path = require('path');
const Database = require('better-sqlite3');
const PrTasks = require('../src/services/pr-tasks');
const AgentSessions = require('../src/services/agent-sessions');

const dbPath = process.env.SESSIONS_DB_PATH
    || path.join(__dirname, '../src/data/slack-sessions.db');
const db = new Database(dbPath);
const prTasks = new PrTasks(db);
const sessions = new AgentSessions(db);
const prByKey = db.prepare(
    'SELECT * FROM pr_tasks WHERE repo=? AND number=?'
);
const allSessions = db.prepare(`
    SELECT * FROM agent_sessions
    ORDER BY COALESCE(last_used_at, created_at) DESC
`);
const [command, ...args] = process.argv.slice(2);

function option(name) {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} needs a value`);
    }
    return value;
}

function resolvePr(ref) {
    const match = /^([^#]+\/[^#]+)#(\d+)$/.exec(ref || '');
    if (!match) {
        throw new Error(
            `invalid PR '${ref}' (expected owner/repo#123)`
        );
    }
    const task = prByKey.get(match[1], Number(match[2]));
    if (!task) {
        throw new Error(
            `PR '${ref}' is not in pr_tasks; wait for a board sweep`
        );
    }
    return task;
}

function uniqueRecent(rows) {
    const byId = new Map(rows.map(row => [row.id, row]));
    return [...byId.values()].sort((left, right) => {
        const leftUsed = left.last_used_at || left.created_at;
        const rightUsed = right.last_used_at || right.created_at;
        return rightUsed - leftUsed;
    });
}

// A typo'd PR ref or a forgotten --key is an expected way to use this wrong,
// not a crash: print the reason and nothing else.
try {
    run();
} catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
}

function run() {
switch (command) {
    case 'link': {
        const prRef = option('--pr');
        const issueKey = option('--issue');
        const task = prRef ? resolvePr(prRef) : null;
        const issue = issueKey
            ? sessions.upsertIssue({
                key: issueKey,
                url: option('--issue-url'),
                title: option('--issue-title'),
            })
            : null;

        if (task && issue) {
            prTasks.setIssue(task.id, issue.id);
        }

        const row = sessions.add({
            key: option('--key'),
            cli: option('--cli') || 'claude',
            prId: task ? task.id : null,
            issueId: issue ? issue.id : null,
            repo: option('--repo') || (task ? task.repo : null),
            label: option('--label'),
        });
        process.stdout.write(JSON.stringify(row) + '\n');
        break;
    }
    case 'list': {
        const prRef = option('--pr');
        const issueKey = option('--issue');
        const rows = [];

        if (prRef) {
            rows.push(...sessions.sessionsFor(resolvePr(prRef).id));
        }
        if (issueKey) {
            const issue = sessions.issueByKey(issueKey);
            if (issue) rows.push(...sessions.sessionsForIssue(issue.id));
        }
        if (!prRef && !issueKey) {
            rows.push(...allSessions.all());
        }

        process.stdout.write(
            JSON.stringify(uniqueRecent(rows), null, 2) + '\n'
        );
        break;
    }
    case 'issues':
        process.stdout.write(
            JSON.stringify(sessions.listIssues(), null, 2) + '\n'
        );
        break;
    default:
        process.stderr.write(
            'usage: session-cli link --key <uuid> '
            + '[--cli claude] [--pr owner/repo#123] [--issue PAY-2266] '
            + '[--issue-url <url>] [--issue-title <title>] [--repo owner/repo] '
            + '[--label <label>] | list [--pr owner/repo#123] '
            + '[--issue PAY-2266] | issues\n'
        );
        process.exit(1);
}
}
