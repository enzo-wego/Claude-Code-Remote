#!/usr/bin/env node
/**
 * Jobs CLI — enqueue/inspect the Mac-runner queue.
 *   jobs-cli enqueue review --json '{"repo":"wego/payments","pr":412,"url":"..."}'
 *   jobs-cli list
 *   jobs-cli show <id>
 * DB path: JOBS_DB_PATH env, else the bot's slack-sessions.db.
 */
const path = require('path');
const Database = require('better-sqlite3');
const Jobs = require('../src/services/jobs');

const dbPath = process.env.JOBS_DB_PATH
    || path.join(__dirname, '../src/data/slack-sessions.db');
const jobs = new Jobs(new Database(dbPath));
const [command, ...args] = process.argv.slice(2);

switch (command) {
    case 'enqueue': {
        const kind = args[0];
        const jsonIndex = args.indexOf('--json');
        const payload = JSON.parse(args[jsonIndex + 1]);
        const dedupeKey = kind === 'review' && payload.repo && payload.pr
            ? `review:${payload.repo}#${payload.pr}`
            : null;
        const row = jobs.enqueue(kind, payload, { dedupeKey });
        process.stdout.write(JSON.stringify(row || { deduped: true }) + '\n');
        break;
    }
    case 'list':
        process.stdout.write(JSON.stringify(jobs.recent(20), null, 2) + '\n');
        break;
    case 'show':
        process.stdout.write(JSON.stringify(
            jobs.get(Number(args[0])),
            null,
            2
        ) + '\n');
        break;
    default:
        process.stderr.write(
            'usage: jobs-cli enqueue <kind> --json <payload> | list | show <id>\n'
        );
        process.exit(1);
}
