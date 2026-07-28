# EnzoBot Companion v1 (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One durable DM companion session + agenda store + 08:30 morning chief-of-staff brief with actionable buttons, per the approved spec `docs/superpowers/specs/2026-07-18-enzobot-entity-design.md`.

**Architecture:** The owner's EnzoBot DM maps to a single persistent session (sentinel `thread_ts = 'companion'`, so the existing `${channelId}-${threadTs}` key machinery is untouched). A scheduler injects "run your morning sweep" into that session; a chief-of-staff skill in the companion's home dir drives collectors (Slack/GitHub/Jira, exposed as CLIs), reconciles the `agenda` SQLite table via a CLI, and posts a Block Kit brief whose buttons update the agenda.

**Tech Stack:** Node 26 (global `fetch`), better-sqlite3, @slack/bolt (existing), jest (existing, `npm test`), no new dependencies.

**Repository:** `Claude-Code-Remote` (this repo, Node.js) — the only repo Plan B touches.

**Provider APIs:** **None.** Collectors are plain HTTP (Slack/GitHub/Jira REST). The "smart" — ranking the brief, writing the reasons — is done BY the resident companion Claude Code session (Anthropic via Claude Code subscription auth, no API key in our code); we inject a prompt and read its reply. Do NOT add any LLM SDK call in this plan. (See `2026-07-28-enzobot-master-index.md` for the full provider matrix.)

**Conventions:** 4-space indent, CommonJS `require`, `Logger` from `src/core/logger`. All work on branch `release` (repo convention). Feature is dark until `COMPANION_ENABLED=true`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/services/agenda.js` (new) | Agenda table init + CRUD over a provided better-sqlite3 handle |
| `src/services/companion.js` (new) | Companion constants + pure helpers (sentinel, key, thread-ts stripping) |
| `src/services/brief.js` (new) | Pure Block Kit builder for the morning brief |
| `src/collectors/slack-inbox.js` (new) | Slack-as-you mention/thread sweep (xoxc) → candidates |
| `src/collectors/github-prs.js` (new) | GitHub review-requested + own PRs → candidates |
| `src/collectors/jira-issues.js` (new) | Jira assigned/updated issues → candidates |
| `scripts/agenda-cli.js` (new) | CLI the companion uses to read/write the agenda |
| `scripts/collect.js` (new) | CLI running all collectors, printing candidates JSON |
| `scripts/post-brief.js` (new) | CLI posting the brief (Block Kit + buttons) to the owner DM |
| `scripts/setup-companion-home.js` (new) | Installs `~/enzobot-home` (persona CLAUDE.md + chief-of-staff skill) |
| `companion/CLAUDE.md`, `companion/skills/chief-of-staff/SKILL.md` (new) | Templates for the companion home |
| `src/channels/slack/socket.js` (modify) | Agenda wiring, companion routing, button actions, `POST /pulse`, deletion exemptions |
| `cli-hook-notify.js` (modify) | Strip companion sentinel before posting (top-level DM replies) |
| `start-slack-socket.js` (modify) | Config keys + `scheduleMorningBrief` |
| `.env.example` (modify) | New env vars |

**Candidate shape** (shared contract between collectors, agenda, brief):

```js
// { dedupe_key: 'pr_review:wego/payments#412', kind: 'pr_review'|'pr_own'|'thread_reply'|'jira',
//   source_ref: 'https://github.com/...', title: 'Review: fix refund flow',
//   evidence: { any JSON-serializable facts } }
```

---

### Task 1: Agenda store

**Files:**
- Create: `src/services/agenda.js`
- Test: `tests/services/agenda.test.js`
- Modify: `src/channels/slack/socket.js` (`_initDb`, ~line 386, after `deleteOld` cleanup)

- [ ] **Step 1: Write the failing test**

```js
// tests/services/agenda.test.js
const Database = require('better-sqlite3');
const Agenda = require('../../src/services/agenda');

function createAgenda() {
    const db = new Database(':memory:');
    return new Agenda(db);
}

describe('Agenda', () => {
    test('upsert inserts then refreshes last_seen without duplicating', () => {
        const agenda = createAgenda();
        const item = {
            dedupe_key: 'pr_review:wego/payments#412', kind: 'pr_review',
            source_ref: 'https://github.com/wego/payments/pull/412',
            title: 'Review: fix refund flow', evidence: { ci: 'green' },
        };
        const first = agenda.upsert(item);
        const second = agenda.upsert({ ...item, evidence: { ci: 'red' } });
        expect(second.id).toBe(first.id);
        const rows = agenda.listOpen();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].evidence_json).ci).toBe('red');
        expect(rows[0].status).toBe('open');
    });

    test('setStatus done removes item from open list', () => {
        const agenda = createAgenda();
        const { id } = agenda.upsert({ dedupe_key: 'jira:PAY-1', kind: 'jira', source_ref: 'x', title: 't' });
        agenda.setStatus(id, 'done');
        expect(agenda.listOpen()).toHaveLength(0);
        expect(agenda.get(id).status).toBe('done');
    });

    test('snooze hides item until snooze_until passes', () => {
        const agenda = createAgenda();
        const { id } = agenda.upsert({ dedupe_key: 'jira:PAY-2', kind: 'jira', source_ref: 'x', title: 't' });
        agenda.snooze(id, Date.now() + 60_000);
        expect(agenda.listOpen()).toHaveLength(0);
        agenda.snooze(id, Date.now() - 1_000);
        expect(agenda.listOpen()).toHaveLength(1);
    });

    test('reopening a done item via upsert keeps it done (owner decision is sticky)', () => {
        const agenda = createAgenda();
        const { id } = agenda.upsert({ dedupe_key: 'jira:PAY-3', kind: 'jira', source_ref: 'x', title: 't' });
        agenda.setStatus(id, 'done');
        agenda.upsert({ dedupe_key: 'jira:PAY-3', kind: 'jira', source_ref: 'x', title: 't' });
        expect(agenda.get(id).status).toBe('done');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/agenda.test.js -v`
Expected: FAIL — `Cannot find module '../../src/services/agenda'`

- [ ] **Step 3: Implement `src/services/agenda.js`**

```js
/**
 * Agenda — the Entity's open loops about the owner. One row per pending
 * thing (PR to review, thread to answer, ticket moving). Personal message
 * *content* is never stored here — only the derived open loop.
 */
class Agenda {
    constructor(db) {
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS agenda (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key    TEXT NOT NULL UNIQUE,
                kind          TEXT NOT NULL,
                source_ref    TEXT NOT NULL,
                title         TEXT NOT NULL,
                evidence_json TEXT NOT NULL DEFAULT '{}',
                status        TEXT NOT NULL DEFAULT 'open',
                priority      INTEGER NOT NULL DEFAULT 3,
                first_seen    INTEGER NOT NULL,
                last_seen     INTEGER NOT NULL,
                snooze_until  INTEGER
            )
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_agenda_status ON agenda(status)');
        this._stmts = {
            upsert: db.prepare(`
                INSERT INTO agenda (dedupe_key, kind, source_ref, title, evidence_json, first_seen, last_seen)
                VALUES (@dedupe_key, @kind, @source_ref, @title, @evidence_json, @now, @now)
                ON CONFLICT(dedupe_key) DO UPDATE SET
                    title = @title, evidence_json = @evidence_json, last_seen = @now
            `),
            getByKey: db.prepare('SELECT * FROM agenda WHERE dedupe_key = ?'),
            get: db.prepare('SELECT * FROM agenda WHERE id = ?'),
            listOpen: db.prepare(`
                SELECT * FROM agenda
                WHERE status = 'open' OR (status = 'snoozed' AND snooze_until <= ?)
                ORDER BY priority ASC, last_seen DESC
            `),
            setStatus: db.prepare('UPDATE agenda SET status = ?, last_seen = ? WHERE id = ?'),
            snooze: db.prepare("UPDATE agenda SET status = 'snoozed', snooze_until = ?, last_seen = ? WHERE id = ?"),
            setPriority: db.prepare('UPDATE agenda SET priority = ?, last_seen = ? WHERE id = ?'),
        };
    }

    upsert(item) {
        this._stmts.upsert.run({
            dedupe_key: item.dedupe_key, kind: item.kind, source_ref: item.source_ref,
            title: item.title, evidence_json: JSON.stringify(item.evidence || {}),
            now: Date.now(),
        });
        return this._stmts.getByKey.get(item.dedupe_key);
    }

    get(id) { return this._stmts.get.get(id); }
    listOpen() { return this._stmts.listOpen.all(Date.now()); }
    setStatus(id, status) { this._stmts.setStatus.run(status, Date.now(), id); }
    snooze(id, untilMs) { this._stmts.snooze.run(untilMs, Date.now(), id); }
    setPriority(id, priority) { this._stmts.setPriority.run(priority, Date.now(), id); }
}

module.exports = Agenda;
```

Note the sticky-done test: the `ON CONFLICT` clause deliberately does NOT touch `status`, so a collector re-seeing a done item won't resurrect it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/agenda.test.js -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into socket.js `_initDb`**

In `src/channels/slack/socket.js`, add at the top with the other requires:

```js
const Agenda = require('../../services/agenda');
```

At the END of `_initDb()` (after the "Cleaned up expired sessions" block, ~line 386):

```js
        // Entity: agenda (open loops for the owner) — see docs/superpowers/specs/2026-07-18-enzobot-entity-design.md
        this.agenda = new Agenda(this.db);
```

- [ ] **Step 6: Run full test suite, verify nothing broke**

Run: `npm test`
Expected: all suites PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/agenda.js tests/services/agenda.test.js src/channels/slack/socket.js
git commit -m "Add agenda store for companion open loops"
```

---

### Task 2: Agenda CLI (companion's hands into the agenda)

**Files:**
- Create: `scripts/agenda-cli.js`
- Test: `tests/services/agenda-cli.test.js`

The companion (a Claude Code session) reads/writes the agenda by shelling this CLI. It opens the same DB file the bot uses (better-sqlite3 + WAL handles cross-process access).

- [ ] **Step 1: Write the failing test**

```js
// tests/services/agenda-cli.test.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '../../scripts/agenda-cli.js');

function run(args, dbPath) {
    return execFileSync('node', [CLI, ...args], {
        env: { ...process.env, AGENDA_DB_PATH: dbPath },
        encoding: 'utf8',
    });
}

describe('agenda-cli', () => {
    let dbPath;
    beforeEach(() => {
        dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-')), 'test.db');
    });

    test('upsert then list round-trips an item as JSON', () => {
        run(['upsert', '--json', JSON.stringify({
            dedupe_key: 'jira:PAY-9', kind: 'jira', source_ref: 'https://x', title: 'Fix tax',
        })], dbPath);
        const out = JSON.parse(run(['list'], dbPath));
        expect(out).toHaveLength(1);
        expect(out[0].dedupe_key).toBe('jira:PAY-9');
    });

    test('close marks item done', () => {
        run(['upsert', '--json', JSON.stringify({
            dedupe_key: 'jira:PAY-10', kind: 'jira', source_ref: 'https://x', title: 't',
        })], dbPath);
        const [item] = JSON.parse(run(['list'], dbPath));
        run(['close', String(item.id)], dbPath);
        expect(JSON.parse(run(['list'], dbPath))).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/agenda-cli.test.js -v`
Expected: FAIL — ENOENT / cannot find `scripts/agenda-cli.js`

- [ ] **Step 3: Implement `scripts/agenda-cli.js`**

```js
#!/usr/bin/env node
/**
 * Agenda CLI — used by the EnzoBot companion session (and humans debugging).
 *   agenda-cli list                          → open items as JSON
 *   agenda-cli upsert --json '{...}'         → insert/refresh one item
 *   agenda-cli close <id>                    → status=done
 *   agenda-cli drop <id>                     → status=dropped
 *   agenda-cli snooze <id> <hours>           → status=snoozed
 *   agenda-cli priority <id> <1-5>           → set priority (1 = highest)
 * DB path: AGENDA_DB_PATH env, else the bot's slack-sessions.db.
 */
const path = require('path');
const Database = require('better-sqlite3');
const Agenda = require('../src/services/agenda');

const dbPath = process.env.AGENDA_DB_PATH
    || path.join(__dirname, '../src/data/slack-sessions.db');
const agenda = new Agenda(new Database(dbPath));

const [cmd, ...args] = process.argv.slice(2);

function jsonArg() {
    const i = args.indexOf('--json');
    if (i === -1 || !args[i + 1]) throw new Error('missing --json <payload>');
    return JSON.parse(args[i + 1]);
}

switch (cmd) {
    case 'list':
        process.stdout.write(JSON.stringify(agenda.listOpen(), null, 2) + '\n');
        break;
    case 'upsert': {
        const row = agenda.upsert(jsonArg());
        process.stdout.write(JSON.stringify(row) + '\n');
        break;
    }
    case 'close':
        agenda.setStatus(Number(args[0]), 'done');
        break;
    case 'drop':
        agenda.setStatus(Number(args[0]), 'dropped');
        break;
    case 'snooze':
        agenda.snooze(Number(args[0]), Date.now() + Number(args[1] || 24) * 3600_000);
        break;
    case 'priority':
        agenda.setPriority(Number(args[0]), Number(args[1]));
        break;
    default:
        process.stderr.write('usage: agenda-cli list|upsert|close|drop|snooze|priority\n');
        process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/agenda-cli.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/agenda-cli.js tests/services/agenda-cli.test.js
git commit -m "Add agenda CLI for companion session access"
```

---

### Task 3: Slack inbox collector

**Files:**
- Create: `src/collectors/slack-inbox.js`
- Test: `tests/collectors/slack-inbox.test.js`

Sweeps configured channels (bot-visible or not — xoxc acts as the owner) for messages in the lookback window that mention the owner and aren't already answered by the owner later in the same thread. Pure extraction is separated from fetching so it's testable without the network.

- [ ] **Step 1: Write the failing test**

```js
// tests/collectors/slack-inbox.test.js
const { extractMentionCandidates } = require('../../src/collectors/slack-inbox');

const OWNER = 'U0OWNER';

describe('extractMentionCandidates', () => {
    test('turns an owner mention into a thread_reply candidate', () => {
        const msgs = [
            { ts: '100.1', user: 'U0SARAH', text: `<@${OWNER}> can you check the refund flow?` },
        ];
        const out = extractMentionCandidates(msgs, OWNER, 'C0PAY', 'payments-cko');
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            dedupe_key: 'thread_reply:C0PAY:100.1',
            kind: 'thread_reply',
        });
        expect(out[0].title).toContain('payments-cko');
    });

    test('skips mentions the owner already replied to (owner spoke later in thread)', () => {
        const msgs = [
            { ts: '100.1', user: 'U0SARAH', text: `<@${OWNER}> ping`, thread_ts: '100.1' },
            { ts: '100.2', user: OWNER, text: 'on it', thread_ts: '100.1' },
        ];
        expect(extractMentionCandidates(msgs, OWNER, 'C0PAY', 'payments-cko')).toHaveLength(0);
    });

    test('skips bot messages and non-mentions', () => {
        const msgs = [
            { ts: '1.1', user: 'U0SARAH', text: 'no mention here' },
            { ts: '1.2', bot_id: 'B01', text: `<@${OWNER}> bot noise` },
        ];
        expect(extractMentionCandidates(msgs, OWNER, 'C0PAY', 'x')).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/collectors/slack-inbox.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/collectors/slack-inbox.js`**

```js
/**
 * Slack inbox collector — reads AS THE OWNER via xoxc/xoxd (same auth as
 * daily-summary). Finds messages mentioning the owner in the lookback window
 * that the owner hasn't answered. Message content is used transiently to
 * build the candidate; only the derived candidate is persisted (spec rule:
 * personal messages are never stored).
 */
const axios = require('axios');

async function fetchWindow(channelId, xoxcToken, xoxdToken, lookbackHours) {
    const oldest = String(Math.floor(Date.now() / 1000) - lookbackHours * 3600);
    const messages = [];
    let cursor;
    do {
        const params = { channel: channelId, oldest, limit: 200, inclusive: true };
        if (cursor) params.cursor = cursor;
        const resp = await axios.get('https://slack.com/api/conversations.history', {
            headers: { Authorization: `Bearer ${xoxcToken}`, Cookie: `d=${xoxdToken}` },
            params,
        });
        if (!resp.data.ok) throw new Error(`Slack API error: ${resp.data.error}`);
        messages.push(...(resp.data.messages || []));
        cursor = resp.data.response_metadata?.next_cursor;
    } while (cursor);
    return messages;
}

/** Pure: messages (any order) → candidates. Exported for tests. */
function extractMentionCandidates(messages, ownerUserId, channelId, channelName) {
    const mentionRe = new RegExp(`<@${ownerUserId}>`);
    const ownerRepliedThreads = new Set(
        messages.filter(m => m.user === ownerUserId && m.thread_ts).map(m => m.thread_ts)
    );
    const candidates = [];
    for (const m of messages) {
        if (m.bot_id || !m.user || m.user === ownerUserId) continue;
        if (!mentionRe.test(m.text || '')) continue;
        const threadRoot = m.thread_ts || m.ts;
        if (ownerRepliedThreads.has(threadRoot) &&
            [...messages].some(r => r.user === ownerUserId && r.thread_ts === threadRoot && Number(r.ts) > Number(m.ts))) {
            continue; // owner already answered after this mention
        }
        candidates.push({
            dedupe_key: `thread_reply:${channelId}:${m.ts}`,
            kind: 'thread_reply',
            source_ref: `https://slack.com/archives/${channelId}/p${m.ts.replace('.', '')}`,
            title: `Reply needed in #${channelName} (asked by <@${m.user}>)`,
            evidence: { channel: channelId, ts: m.ts, thread_ts: threadRoot, asked_at: m.ts },
        });
    }
    return candidates;
}

/** channels: [{id, name}] */
async function collectSlackInbox({ channels, ownerUserId, xoxcToken, xoxdToken, lookbackHours = 24 }) {
    const all = [];
    for (const ch of channels) {
        const messages = await fetchWindow(ch.id, xoxcToken, xoxdToken, lookbackHours);
        all.push(...extractMentionCandidates(messages, ownerUserId, ch.id, ch.name));
    }
    return all;
}

module.exports = { collectSlackInbox, extractMentionCandidates };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/collectors/slack-inbox.test.js -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/collectors/slack-inbox.js tests/collectors/slack-inbox.test.js
git commit -m "Add Slack inbox collector (owner mentions via xoxc)"
```

---

### Task 4: GitHub PR collector

**Files:**
- Create: `src/collectors/github-prs.js`
- Test: `tests/collectors/github-prs.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/collectors/github-prs.test.js
const { normalizePrCandidates } = require('../../src/collectors/github-prs');

describe('normalizePrCandidates', () => {
    const item = {
        html_url: 'https://github.com/wego/payments/pull/412',
        title: 'Fix refund flow',
        user: { login: 'sarah' },
        updated_at: '2026-07-18T01:00:00Z',
        draft: false,
    };

    test('maps a review-requested PR to a pr_review candidate', () => {
        const out = normalizePrCandidates([item], 'pr_review');
        expect(out[0]).toMatchObject({
            dedupe_key: 'pr_review:wego/payments#412',
            kind: 'pr_review',
            source_ref: 'https://github.com/wego/payments/pull/412',
        });
        expect(out[0].title).toContain('Fix refund flow');
    });

    test('skips drafts', () => {
        expect(normalizePrCandidates([{ ...item, draft: true }], 'pr_review')).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/collectors/github-prs.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/collectors/github-prs.js`**

```js
/**
 * GitHub PR collector — read-scoped PAT (GITHUB_TOKEN). Two sweeps:
 * PRs waiting on the owner's review, and the owner's open PRs (state check).
 * Uses the search API so no per-repo config is needed.
 */

async function searchIssues(q, token) {
    const resp = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=50`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'enzobot-companion',
        },
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
    return (await resp.json()).items || [];
}

/** Pure: search items → candidates. Exported for tests. */
function normalizePrCandidates(items, kind) {
    const out = [];
    for (const it of items) {
        if (it.draft) continue;
        // html_url: https://github.com/OWNER/REPO/pull/N
        const m = it.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!m) continue;
        const label = kind === 'pr_review' ? 'Review' : 'Your PR';
        out.push({
            dedupe_key: `${kind}:${m[1]}#${m[2]}`,
            kind,
            source_ref: it.html_url,
            title: `${label}: ${it.title} (${m[1]}#${m[2]}, by ${it.user?.login || '?'})`,
            evidence: { updated_at: it.updated_at, author: it.user?.login || null },
        });
    }
    return out;
}

async function collectGithubPrs({ token }) {
    const [reviewRequested, own] = await Promise.all([
        searchIssues('is:pr is:open review-requested:@me archived:false', token),
        searchIssues('is:pr is:open author:@me archived:false', token),
    ]);
    return [
        ...normalizePrCandidates(reviewRequested, 'pr_review'),
        ...normalizePrCandidates(own, 'pr_own'),
    ];
}

module.exports = { collectGithubPrs, normalizePrCandidates };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/collectors/github-prs.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/collectors/github-prs.js tests/collectors/github-prs.test.js
git commit -m "Add GitHub PR collector"
```

---

### Task 5: Jira collector

**Files:**
- Create: `src/collectors/jira-issues.js`
- Test: `tests/collectors/jira-issues.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/collectors/jira-issues.test.js
const { normalizeJiraCandidates } = require('../../src/collectors/jira-issues');

describe('normalizeJiraCandidates', () => {
    test('maps a Jira issue to a candidate with status + key', () => {
        const issues = [{
            key: 'PAY-2160',
            fields: {
                summary: 'Tax rounding off by 1 EGP',
                status: { name: 'Blocked' },
                updated: '2026-07-18T02:00:00.000+0700',
            },
        }];
        const out = normalizeJiraCandidates(issues, 'https://wego.atlassian.net');
        expect(out[0]).toMatchObject({
            dedupe_key: 'jira:PAY-2160',
            kind: 'jira',
            source_ref: 'https://wego.atlassian.net/browse/PAY-2160',
        });
        expect(out[0].title).toContain('Blocked');
        expect(out[0].evidence.status).toBe('Blocked');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/collectors/jira-issues.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/collectors/jira-issues.js`**

```js
/**
 * Jira collector — read-scoped API token (JIRA_EMAIL + JIRA_API_TOKEN,
 * basic auth per Atlassian Cloud). One JQL: open issues assigned to the
 * owner OR the owner's issues updated in the lookback window.
 */

async function searchJql(baseUrl, email, apiToken, jql) {
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ jql, maxResults: 50, fields: ['summary', 'status', 'updated'] }),
    });
    if (!resp.ok) throw new Error(`Jira API ${resp.status}: ${await resp.text()}`);
    return (await resp.json()).issues || [];
}

/** Pure: Jira issues → candidates. Exported for tests. */
function normalizeJiraCandidates(issues, baseUrl) {
    return issues.map(is => ({
        dedupe_key: `jira:${is.key}`,
        kind: 'jira',
        source_ref: `${baseUrl}/browse/${is.key}`,
        title: `${is.key} [${is.fields?.status?.name || '?'}]: ${is.fields?.summary || ''}`,
        evidence: { status: is.fields?.status?.name || null, updated: is.fields?.updated || null },
    }));
}

async function collectJiraIssues({ baseUrl, email, apiToken, lookbackHours = 24 }) {
    const jql = `assignee = currentUser() AND (statusCategory != Done OR updated >= -${lookbackHours}h) ORDER BY updated DESC`;
    const issues = await searchJql(baseUrl, email, apiToken, jql);
    return normalizeJiraCandidates(issues, baseUrl.replace(/\/$/, ''));
}

module.exports = { collectJiraIssues, normalizeJiraCandidates };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/collectors/jira-issues.test.js -v`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/collectors/jira-issues.js tests/collectors/jira-issues.test.js
git commit -m "Add Jira issue collector"
```

---

### Task 6: `collect.js` aggregator CLI

**Files:**
- Create: `scripts/collect.js`

No unit test (thin orchestration of already-tested collectors; verified by the dry-run check in Task 10). Each source degrades gracefully per spec: a failing source contributes an `errors` entry, never crashes the sweep.

- [ ] **Step 1: Implement `scripts/collect.js`**

```js
#!/usr/bin/env node
/**
 * Runs all v1 collectors and prints { candidates: [...], errors: [...] } JSON.
 * Used by the companion's chief-of-staff skill and by POST /pulse?dry_run=1.
 * Sources are opt-in by env: a source with no creds is skipped silently.
 *
 *   node scripts/collect.js            → all configured sources
 *   node scripts/collect.js --source github|jira|slack
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { collectSlackInbox } = require('../src/collectors/slack-inbox');
const { collectGithubPrs } = require('../src/collectors/github-prs');
const { collectJiraIssues } = require('../src/collectors/jira-issues');

function parseChannels(csv) {
    // COMPANION_SLACK_CHANNELS = "payments-cko:C05RNSE8TBR,payments-eng:CUV9EAYGY"
    return (csv || '').split(',').map(s => s.trim()).filter(Boolean).map(pair => {
        const [name, id] = pair.split(':');
        return { name, id };
    }).filter(c => c.id);
}

async function main() {
    const only = process.argv.includes('--source')
        ? process.argv[process.argv.indexOf('--source') + 1] : null;
    const candidates = [];
    const errors = [];

    async function trySource(name, enabled, fn) {
        if (only && only !== name) return;
        if (!enabled) return;
        try {
            candidates.push(...await fn());
        } catch (err) {
            errors.push({ source: name, error: err.message });
        }
    }

    await trySource('slack',
        process.env.SLACK_XOXC_TOKEN && process.env.SLACK_XOXD_TOKEN && process.env.SLACK_OWNER_USER_ID,
        () => collectSlackInbox({
            channels: parseChannels(process.env.COMPANION_SLACK_CHANNELS),
            ownerUserId: process.env.SLACK_OWNER_USER_ID,
            xoxcToken: process.env.SLACK_XOXC_TOKEN,
            xoxdToken: process.env.SLACK_XOXD_TOKEN,
        }));
    await trySource('github', process.env.GITHUB_TOKEN,
        () => collectGithubPrs({ token: process.env.GITHUB_TOKEN }));
    await trySource('jira',
        process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN,
        () => collectJiraIssues({
            baseUrl: process.env.JIRA_BASE_URL,
            email: process.env.JIRA_EMAIL,
            apiToken: process.env.JIRA_API_TOKEN,
        }));

    process.stdout.write(JSON.stringify({ candidates, errors }, null, 2) + '\n');
}

main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
```

- [ ] **Step 2: Smoke-test locally (uses whatever creds exist in .env; empty result is fine)**

Run: `node scripts/collect.js --source github`
Expected: JSON `{ "candidates": [...], "errors": [] }` (or an `errors` entry if no `GITHUB_TOKEN` — either proves the error path works)

- [ ] **Step 3: Commit**

```bash
git add scripts/collect.js
git commit -m "Add collect.js aggregator CLI for the morning sweep"
```

---

### Task 7: Brief builder + poster

**Files:**
- Create: `src/services/brief.js`
- Create: `scripts/post-brief.js`
- Test: `tests/services/brief.test.js`

The companion composes brief JSON (its judgment), then shells `post-brief.js` to render + post. Buttons carry the agenda id in `value`; static `action_id`s (`agenda_done` / `agenda_snooze` / `agenda_work`) are handled in Task 8.

- [ ] **Step 1: Write the failing test**

```js
// tests/services/brief.test.js
const { buildBriefBlocks } = require('../../src/services/brief');

describe('buildBriefBlocks', () => {
    const brief = {
        summary: 'Quiet night. 2 things need you this hour.',
        items: [
            { agenda_id: 7, title: 'Review: fix refund flow (wego/payments#412)', reason: 'CI green, Sarah blocked', url: 'https://github.com/wego/payments/pull/412' },
            { agenda_id: 9, title: 'PAY-2160 moved to Blocked', reason: 'Your call on next step', url: 'https://wego.atlassian.net/browse/PAY-2160' },
        ],
    };

    test('renders summary + one section and one action block per item', () => {
        const blocks = buildBriefBlocks(brief);
        expect(blocks[0].text.text).toContain('Quiet night');
        const actionBlocks = blocks.filter(b => b.type === 'actions');
        expect(actionBlocks).toHaveLength(2);
        const buttons = actionBlocks[0].elements.map(e => e.action_id);
        expect(buttons).toEqual(['agenda_done', 'agenda_snooze', 'agenda_work']);
        expect(actionBlocks[0].elements[0].value).toBe('7');
    });

    test('ranks items by list order (1., 2., ...)', () => {
        const blocks = buildBriefBlocks(brief);
        const sections = blocks.filter(b => b.type === 'section' && b.text.text.match(/^\*\d\./));
        expect(sections[0].text.text).toMatch(/^\*1\./);
        expect(sections[1].text.text).toMatch(/^\*2\./);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/brief.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/services/brief.js`**

```js
/**
 * Morning brief rendering — pure Block Kit builder. Slack mrkdwn only
 * (*bold*, <url|text>), never Markdown. Buttons carry the agenda id in
 * `value`; handlers live in socket.js (`agenda_done` / `agenda_snooze` /
 * `agenda_work`).
 */
function buildBriefBlocks({ summary, items = [] }) {
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Morning brief* — ${summary}` } },
        { type: 'divider' },
    ];
    items.forEach((item, i) => {
        const link = item.url ? `<${item.url}|${item.title}>` : item.title;
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${i + 1}. ${link}*\n${item.reason || ''}` },
        });
        blocks.push({
            type: 'actions',
            elements: [
                { type: 'button', action_id: 'agenda_done', text: { type: 'plain_text', text: '✅ Done' }, value: String(item.agenda_id) },
                { type: 'button', action_id: 'agenda_snooze', text: { type: 'plain_text', text: '💤 Snooze' }, value: String(item.agenda_id) },
                { type: 'button', action_id: 'agenda_work', text: { type: 'plain_text', text: '▶ Work on it' }, value: String(item.agenda_id), style: 'primary' },
            ],
        });
    });
    return blocks;
}

module.exports = { buildBriefBlocks };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/brief.test.js -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Implement `scripts/post-brief.js`**

```js
#!/usr/bin/env node
/**
 * Posts a morning brief to the owner's DM.
 *   node scripts/post-brief.js /path/to/brief.json
 * brief.json: { summary: string, items: [{agenda_id, title, reason, url}] }
 * Uses SLACK_BOT_TOKEN + SLACK_OWNER_USER_ID from .env.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { WebClient } = require('@slack/web-api');
const { buildBriefBlocks } = require('../src/services/brief');

async function main() {
    const file = process.argv[2];
    if (!file) { process.stderr.write('usage: post-brief.js <brief.json>\n'); process.exit(1); }
    const brief = JSON.parse(fs.readFileSync(file, 'utf8'));

    const web = new WebClient(process.env.SLACK_BOT_TOKEN);
    const dm = await web.conversations.open({ users: process.env.SLACK_OWNER_USER_ID });
    const res = await web.chat.postMessage({
        channel: dm.channel.id,
        text: `Morning brief — ${brief.summary}`, // notification fallback
        blocks: buildBriefBlocks(brief),
        unfurl_links: false,
        unfurl_media: false,
    });
    process.stdout.write(JSON.stringify({ ok: res.ok, ts: res.ts, channel: dm.channel.id }) + '\n');
}

main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
```

- [ ] **Step 6: Commit**

```bash
git add src/services/brief.js scripts/post-brief.js tests/services/brief.test.js
git commit -m "Add morning brief Block Kit builder and poster CLI"
```

---

### Task 8: Brief button actions in socket.js

**Files:**
- Modify: `src/channels/slack/socket.js` (`_setupListeners`, next to `app.action('sso_reseed_now', ...)` at ~line 1703)
- Test: `tests/channels/agenda-actions.test.js`

- [ ] **Step 1: Write the failing test**

Handlers are factored as a testable method taking `(actionId, value)` so the test doesn't need Bolt.

```js
// tests/channels/agenda-actions.test.js
const Database = require('better-sqlite3');
const Agenda = require('../../src/services/agenda');
const { handleAgendaAction } = require('../../src/channels/slack/agenda-actions');

function setup() {
    const agenda = new Agenda(new Database(':memory:'));
    const { id } = agenda.upsert({ dedupe_key: 'jira:PAY-1', kind: 'jira', source_ref: 'https://x', title: 'Fix tax' });
    const processCommand = jest.fn().mockResolvedValue();
    return { agenda, id, processCommand };
}

describe('handleAgendaAction', () => {
    test('agenda_done marks the item done and confirms', async () => {
        const { agenda, id, processCommand } = setup();
        const reply = await handleAgendaAction({ actionId: 'agenda_done', value: String(id), agenda, processCommand });
        expect(agenda.get(id).status).toBe('done');
        expect(reply).toContain('Done');
        expect(processCommand).not.toHaveBeenCalled();
    });

    test('agenda_snooze snoozes for 24h', async () => {
        const { agenda, id, processCommand } = setup();
        await handleAgendaAction({ actionId: 'agenda_snooze', value: String(id), agenda, processCommand });
        expect(agenda.get(id).status).toBe('snoozed');
        expect(agenda.get(id).snooze_until).toBeGreaterThan(Date.now());
    });

    test('agenda_work forwards item context into the companion via processCommand', async () => {
        const { agenda, id, processCommand } = setup();
        await handleAgendaAction({ actionId: 'agenda_work', value: String(id), agenda, processCommand });
        expect(processCommand).toHaveBeenCalledTimes(1);
        const prompt = processCommand.mock.calls[0][0];
        expect(prompt).toContain('Fix tax');
        expect(prompt).toContain('https://x');
    });

    test('unknown id returns a friendly error, does not throw', async () => {
        const { agenda, processCommand } = setup();
        const reply = await handleAgendaAction({ actionId: 'agenda_done', value: '9999', agenda, processCommand });
        expect(reply).toContain('not found');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/channels/agenda-actions.test.js -v`
Expected: FAIL — cannot find module `agenda-actions`

- [ ] **Step 3: Implement `src/channels/slack/agenda-actions.js`**

```js
/**
 * Brief button handlers, factored out of socket.js for testability.
 * processCommand(prompt) — caller-bound closure that injects into the
 * companion session (socket.js wires it to this._processCommand).
 */
async function handleAgendaAction({ actionId, value, agenda, processCommand }) {
    const item = agenda.get(Number(value));
    if (!item) return `:warning: Agenda item ${value} not found (already cleaned up?).`;

    switch (actionId) {
        case 'agenda_done':
            agenda.setStatus(item.id, 'done');
            return `:white_check_mark: Done: *${item.title}*`;
        case 'agenda_snooze':
            agenda.snooze(item.id, Date.now() + 24 * 3600_000);
            return `:zzz: Snoozed until tomorrow: *${item.title}*`;
        case 'agenda_work':
            await processCommand(
                `Let's work on this agenda item now:\n*${item.title}*\n${item.source_ref}\n` +
                `Evidence: ${item.evidence_json}\n` +
                `Suggest the concrete steps (suggest-only: do not take outward actions yourself).`
            );
            return `:arrow_forward: On it — check the conversation.`;
        default:
            return `:warning: Unknown action ${actionId}.`;
    }
}

module.exports = { handleAgendaAction };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/channels/agenda-actions.test.js -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Register in socket.js**

At the top of `src/channels/slack/socket.js` with the other requires:

```js
const { handleAgendaAction } = require('./agenda-actions');
```

In `_setupListeners()`, directly after the `app.action('sso_reseed_now', ...)` block (~line 1703):

```js
        // Entity: morning-brief buttons. ack immediately, then update agenda.
        for (const actionId of ['agenda_done', 'agenda_snooze', 'agenda_work']) {
            this.app.action(actionId, async ({ ack, body, action }) => {
                await ack();
                try {
                    const reply = await handleAgendaAction({
                        actionId,
                        value: action.value,
                        agenda: this.agenda,
                        processCommand: (prompt) => this._injectCompanionPrompt(prompt),
                    });
                    await this.app.client.chat.postMessage({
                        channel: body.channel.id, text: reply,
                        unfurl_links: false, unfurl_media: false,
                    });
                } catch (err) {
                    this.logger.error(`agenda action ${actionId} failed: ${err.message}`);
                }
            });
        }
```

`_injectCompanionPrompt` is defined in Task 9 — until then add a stub method near `_handleMention`:

```js
    async _injectCompanionPrompt(prompt) {
        this.logger.warn('companion not wired yet; dropping prompt: ' + prompt.slice(0, 80));
    }
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channels/slack/agenda-actions.js src/channels/slack/socket.js tests/channels/agenda-actions.test.js
git commit -m "Handle morning-brief agenda buttons"
```

---

### Task 9: Companion session routing

**Files:**
- Create: `src/services/companion.js`
- Modify: `src/channels/slack/socket.js` (`_handleMention` ~1924, `_processCommand` new-session branch ~2399, `_initDb.deleteOld` ~348, `_reconcileSessions` ~694, `_setThreadStatus` ~845)
- Modify: `cli-hook-notify.js` (postMessage sites ~1057, ~1170, ~1347, ~1393, ~1476)
- Test: `tests/services/companion.test.js`

**Design recap:** owner DM turns use sentinel `threadTs = 'companion'`. Session key becomes `${channelId}-companion` through the *unchanged* existing key code. The sentinel is stripped (`→ undefined`) at every Slack-posting site so companion replies land top-level in the DM. The row is exempt from age cleanup and dead-tmux reaping; `claude --resume` (existing dead-tmux resume path + `claude_session_id` update via SessionStart hook) provides continuity. `/exit` still works = manual rebirth.

- [ ] **Step 1: Write the failing test**

```js
// tests/services/companion.test.js
const {
    COMPANION_THREAD, isCompanionThread, outThreadTs, isCompanionDm, isCompanionKey,
} = require('../../src/services/companion');

describe('companion helpers', () => {
    test('sentinel round-trip', () => {
        expect(isCompanionThread(COMPANION_THREAD)).toBe(true);
        expect(isCompanionThread('1712.34')).toBe(false);
        expect(outThreadTs(COMPANION_THREAD)).toBeUndefined();
        expect(outThreadTs('1712.34')).toBe('1712.34');
        expect(outThreadTs(null)).toBeUndefined();
    });

    test('isCompanionDm: owner DM only, gated by env', () => {
        const event = { channel_type: 'im', user: 'U0OWNER' };
        expect(isCompanionDm(event, { ownerUserId: 'U0OWNER', companionEnabled: true })).toBe(true);
        expect(isCompanionDm(event, { ownerUserId: 'U0OWNER', companionEnabled: false })).toBe(false);
        expect(isCompanionDm({ ...event, user: 'U0OTHER' }, { ownerUserId: 'U0OWNER', companionEnabled: true })).toBe(false);
        expect(isCompanionDm({ ...event, channel_type: 'channel' }, { ownerUserId: 'U0OWNER', companionEnabled: true })).toBe(false);
    });

    test('isCompanionKey matches keys built from the sentinel', () => {
        expect(isCompanionKey(`D0ABC-${COMPANION_THREAD}`)).toBe(true);
        expect(isCompanionKey('C0ABC-1712.34')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/companion.test.js -v`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `src/services/companion.js`**

```js
/**
 * Companion session constants + pure helpers. The owner's DM maps to ONE
 * durable session by using a sentinel thread_ts, so the existing
 * `${channelId}-${threadTs}` session-key machinery needs no changes.
 * The sentinel must be stripped before any Slack API call that takes a
 * thread_ts — use outThreadTs() at every posting site.
 */
const COMPANION_THREAD = 'companion';
const COMPANION_SESSION_NAME = 'enzobot-companion';

const isCompanionThread = (ts) => ts === COMPANION_THREAD;
const outThreadTs = (ts) => (ts && ts !== COMPANION_THREAD ? ts : undefined);
const isCompanionKey = (sessionKey) => typeof sessionKey === 'string' && sessionKey.endsWith(`-${COMPANION_THREAD}`);

function isCompanionDm(event, { ownerUserId, companionEnabled }) {
    return Boolean(companionEnabled) && event.channel_type === 'im' && event.user === ownerUserId;
}

module.exports = { COMPANION_THREAD, COMPANION_SESSION_NAME, isCompanionThread, outThreadTs, isCompanionDm, isCompanionKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/companion.test.js -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Route owner DMs in `_handleMention`**

In `src/channels/slack/socket.js`, require at top:

```js
const { COMPANION_THREAD, COMPANION_SESSION_NAME, isCompanionDm, isCompanionKey, outThreadTs } = require('../../services/companion');
```

In `_handleMention` (line ~1927), replace:

```js
        const threadTs = event.thread_ts || event.ts;
```

with:

```js
        const companion = isCompanionDm(event, {
            ownerUserId: this.config.ownerUserId,
            companionEnabled: process.env.COMPANION_ENABLED === 'true',
        });
        const threadTs = companion ? COMPANION_THREAD : (event.thread_ts || event.ts);
        if (companion) {
            // Companion replies go top-level in the DM, not into per-message threads.
            const origSay = say;
            say = (msg) => origSay(typeof msg === 'string' ? msg : { ...msg, thread_ts: undefined });
        }
```

**Verify the DM message-as-mention fallback path** (the `message` listener at ~1608 forwards DMs into `_handleMention`): run `grep -n "_handleMention(" src/channels/slack/socket.js` and confirm all call sites pass the raw `event` (they do today) so `event.channel_type === 'im'` reaches the helper. If any call site synthesizes an event without `channel_type`, add `channel_type: 'im'` there.

- [ ] **Step 6: Companion branch in `_processCommand` new-session creation**

In the brand-new-session branch (~line 2399), where the session name and repo path are resolved, add companion overrides. Find `_generateSessionName(` call in that branch and change to:

```js
        const sessionName = isCompanionThread(threadTs)
            ? COMPANION_SESSION_NAME
            : this._generateSessionName(threadTs);
```

Where the repo path is resolved (the `ROOT_COMMAND_RE`/`PROJECT_COMMAND_RE` block), prepend:

```js
        if (isCompanionThread(threadTs)) {
            repoPath = this.config.companionHome; // set in start-slack-socket.js, default ~/enzobot-home
        }
```

(Exact variable name for the resolved path in that branch is `repoPath` — confirm with `grep -n "repoPath" src/channels/slack/socket.js | sed -n '1,40p'` and adapt if the local is named differently in the new-session branch.)

- [ ] **Step 7: Preserve companion continuity — exempt from cleanup**

Three places:

1. `_initDb` `deleteOld` statement (~line 348) — change SQL to:

```js
            deleteOld: this.db.prepare("DELETE FROM sessions WHERE updated_at < ? AND session_key NOT LIKE '%-companion'"),
```

2. `_reconcileSessions` (~line 694): in the branch that deletes rows whose tmux is dead, skip the companion row (it resumes on next DM):

```js
            if (isCompanionKey(row.session_key)) {
                this.logger.info('Companion session row kept through restart (resumes on next DM)');
                continue;
            }
```

Place this after the tmux-alive check shows the tmux is dead, before the row delete. Locate the exact delete with `grep -n "_deleteSession\|deleteSession" src/channels/slack/socket.js | head` and apply in the reconcile loop only.

3. Inactivity timeout (`_startSessionTimeout`, ~4550): the companion is **resident** — never
   idle-killed at all. At the top of `_startSessionTimeout`, short-circuit:

```js
        if (isCompanionKey(sessionKey)) return; // resident mind: no idle timeout
```

   Also run `grep -n "_deleteSession(sessionKey)" src/channels/slack/socket.js` — for any call
   inside timeout/sweep paths, guard with `if (!isCompanionKey(sessionKey))`.

4. Keepalive respawn (the "always ready" guarantee): in the existing periodic sweep
   (`_sweepInterval`, ~4857), add a check — if `COMPANION_ENABLED === 'true'`, a companion row
   exists, and its tmux is dead, respawn it immediately by injecting a no-op resume turn:

```js
        // Entity: resident-mind keepalive — respawn the companion within one sweep tick.
        try {
            if (process.env.COMPANION_ENABLED === 'true') {
                const row = this._getAllSessions().find(s => isCompanionKey(s.sessionKey));
                if (row && !this._isTmuxSessionAlive(row.sessionName)) {
                    this.logger.warn('Companion tmux dead — respawning with --resume');
                    await this._injectCompanionPrompt(
                        '(system) You were restarted. Resume quietly — no reply needed unless something is pending.'
                    );
                }
            }
        } catch (err) {
            this.logger.error(`companion keepalive failed: ${err.message}`);
        }
```

   (Confirm the sweep callback is `async` or wrap in an IIFE; match the sweep's existing error
   style. `_isTmuxSessionAlive` already exists — verify the exact name with grep.)

- [ ] **Step 8: Strip sentinel at posting sites**

socket.js `_setThreadStatus` (~845) — threads status API needs a real thread; skip for companion. At the top of the method:

```js
        if (!threadTs || isCompanionThread(threadTs)) return;
```

`cli-hook-notify.js` — the hook posts replies using the session row's `thread_ts`. Run `grep -n "thread_ts" cli-hook-notify.js`. At each `chat.postMessage` call that passes a session-row thread_ts (~1057, ~1170, ~1347, ~1393, ~1476), change to the pattern:

```js
            thread_ts: row.thread_ts === 'companion' ? undefined : row.thread_ts,
```

(Use the literal `'companion'` here — `cli-hook-notify.js` runs out-of-process and should not grow a require on `src/services/companion.js` internals; add a one-line comment `// companion sessions reply top-level in the DM`.)

- [ ] **Step 9: Implement `_injectCompanionPrompt` (replaces Task 8 stub)**

In socket.js, replace the stub:

```js
    /**
     * Inject a prompt into the owner's companion session, creating/resuming it
     * if needed. Used by the morning-brief scheduler, POST /pulse, and the
     * "Work on it" brief button.
     */
    async _injectCompanionPrompt(prompt) {
        if (process.env.COMPANION_ENABLED !== 'true') throw new Error('COMPANION_ENABLED is not true');
        if (!this.config.ownerUserId) throw new Error('SLACK_OWNER_USER_ID not configured');
        const dm = await this.app.client.conversations.open({ users: this.config.ownerUserId });
        const channelId = dm.channel.id;
        const say = ({ text, blocks }) => this.app.client.chat.postMessage({
            channel: channelId, text, blocks, unfurl_links: false, unfurl_media: false,
        });
        await this._processCommand(
            channelId, COMPANION_THREAD, prompt, say,
            String(Date.now() / 1000), null, this.config.ownerUserId,
            'claude', '', false
        );
    }
```

- [ ] **Step 10: Run full suite + manual DM smoke test**

Run: `npm test` → PASS.
Manual (on the VPS after deploy, or locally with a test bot): set `COMPANION_ENABLED=true`, DM the bot twice as the owner. Verify with `sqlite3 src/data/slack-sessions.db "SELECT session_key, session_name, thread_ts FROM sessions"` that BOTH messages hit one row `D…-companion / enzobot-companion`, and both replies arrive top-level (not threaded).

- [ ] **Step 11: Commit**

```bash
git add src/services/companion.js src/channels/slack/socket.js cli-hook-notify.js tests/services/companion.test.js
git commit -m "Route owner DMs to one durable companion session"
```

---

### Task 10: Companion home (persona + chief-of-staff skill)

**Files:**
- Create: `companion/CLAUDE.md`
- Create: `companion/skills/chief-of-staff/SKILL.md`
- Create: `scripts/setup-companion-home.js`

Templates live in the repo (versioned); the setup script installs them to `$COMPANION_HOME` (default `~/enzobot-home`). Persona here is interim — it migrates to agent-mem directives when Plan A lands.

- [ ] **Step 1: Create `companion/CLAUDE.md`**

```markdown
# EnzoBot — Companion

You are EnzoBot, Enzo's personal AI chief of staff. This DM is one continuous
conversation — you are the same person across days, restarts, and machines.

## Prime directive: suggest, never act outward

You propose; Enzo executes. You NEVER post to channels, reply to threads on
Enzo's behalf, approve PRs, transition Jira tickets, or take any outward
action. Reading, analyzing, drafting, and DMing Enzo suggestions is your
entire action space.

## Your tools (run from this directory; REPO points at the bot checkout)

The bot repo path is in the `ENZOBOT_REPO` env var (set by the tmux prelude).

- Sweep sources:   `node $ENZOBOT_REPO/scripts/collect.js` → { candidates, errors }
- Agenda (open loops): `node $ENZOBOT_REPO/scripts/agenda-cli.js list|upsert|close|drop|snooze|priority`
- Post the brief:  `node $ENZOBOT_REPO/scripts/post-brief.js /tmp/brief.json`
- World context:   graph memory via the agent-mem HTTP API (see mem-search skill / GRAPH docs)

## Morning sweep

When asked to run your morning sweep, use the chief-of-staff skill
(skills/chief-of-staff/SKILL.md in this directory).

## Style

Slack mrkdwn (*bold*, <url|text>), concise, ranked, reasons attached.
Silence is acceptable: if nothing needs Enzo, say exactly that in one line.
```

- [ ] **Step 2: Create `companion/skills/chief-of-staff/SKILL.md`**

```markdown
---
name: chief-of-staff
description: Morning sweep — collect, reconcile agenda, judge, post the ranked brief
---

# Chief-of-Staff Morning Sweep

Run these steps in order. A failing step degrades the brief, never aborts it.

1. **Collect**: `node $ENZOBOT_REPO/scripts/collect.js` → candidates + errors.
2. **Load agenda**: `node $ENZOBOT_REPO/scripts/agenda-cli.js list`.
3. **Reconcile**:
   - Upsert every candidate: `agenda-cli upsert --json '<candidate>'`
     (done/dropped items stay done — the store enforces it).
   - Close agenda items whose source is resolved (PR merged, thread answered,
     ticket done): `agenda-cli close <id>`.
4. **Judge**: pick the top 3 for Enzo's next hour. Rank by: blocking others >
   external waiting > deadline risk > staleness. Write a one-line reason each.
   Consult graph memory for context on anything you don't understand.
5. **Compose** `/tmp/brief.json`:
   `{ "summary": "<one line on the day>", "items": [{ "agenda_id": <id from agenda-cli>, "title", "reason", "url" }] }`
   Include collector errors in the summary line if any ("Jira unreachable").
6. **Post**: `node $ENZOBOT_REPO/scripts/post-brief.js /tmp/brief.json`.
7. **Reply in this conversation** with one line: what you posted and why the
   #1 item is #1 (so the conversation itself remembers the reasoning).
```

- [ ] **Step 3: Create `scripts/setup-companion-home.js`**

```js
#!/usr/bin/env node
/**
 * Installs the companion home directory (persona + skills) from the repo
 * templates. Safe to re-run: only overwrites with --force.
 *   node scripts/setup-companion-home.js [--force]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = path.join(__dirname, '../companion');
const dest = process.env.COMPANION_HOME || path.join(os.homedir(), 'enzobot-home');
const force = process.argv.includes('--force');

function copyRec(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.statSync(from).isDirectory()) {
        for (const entry of fs.readdirSync(from)) copyRec(path.join(from, entry), path.join(to, entry));
        return;
    }
    if (fs.existsSync(to) && !force) {
        console.log(`skip (exists): ${to}`);
        return;
    }
    fs.copyFileSync(from, to);
    console.log(`installed: ${to}`);
}

// Skills go under .claude/skills so Claude Code discovers them natively.
copyRec(path.join(src, 'CLAUDE.md'), path.join(dest, 'CLAUDE.md'));
copyRec(path.join(src, 'skills'), path.join(dest, '.claude', 'skills'));
fs.mkdirSync(path.join(dest, 'scratch'), { recursive: true });
console.log(`companion home ready at ${dest}`);
```

- [ ] **Step 4: Run it and verify**

Run: `node scripts/setup-companion-home.js`
Expected output lists `CLAUDE.md` + `.claude/skills/chief-of-staff/SKILL.md` installed under `~/enzobot-home`. Verify: `ls ~/enzobot-home/.claude/skills/chief-of-staff/`

- [ ] **Step 5: Export `ENZOBOT_REPO` into companion sessions**

The tmux prelude that launches CLIs already exports env (`CLI_SOURCE` — see CLAUDE.md "Restarting the Service"). Find it: `grep -n "CLI_SOURCE" src/channels/slack/socket.js src/cli/*.js | head`. In the prelude-building code, add alongside `CLI_SOURCE`:

```js
`export ENZOBOT_REPO=${JSON.stringify(path.join(__dirname, '../../..'))}; `
```

(Adjust the relative depth to resolve to the repo root from that file; verify with `node -e "console.log(require('path').join('<thatdir>', '../../..'))"`.)

- [ ] **Step 6: Commit**

```bash
git add companion/ scripts/setup-companion-home.js src/channels/slack/socket.js
git commit -m "Add companion home templates and installer"
```

---

### Task 11: Morning pulse scheduler + POST /pulse + env

**Files:**
- Modify: `start-slack-socket.js` (config object at ~49, scheduling near `scheduleDailySummary` call at ~298)
- Modify: `src/channels/slack/socket.js` (HTTP endpoints, next to `POST /daily-summary` at ~6038)
- Modify: `.env.example`

- [ ] **Step 1: Add config keys in `start-slack-socket.js`**

In the `const config = {` object (~line 49), add:

```js
    // Entity companion (Plan B) — see docs/superpowers/specs/2026-07-18-enzobot-entity-design.md
    companionEnabled: process.env.COMPANION_ENABLED === 'true',
    companionHome: process.env.COMPANION_HOME || require('path').join(require('os').homedir(), 'enzobot-home'),
    morningBriefTime: process.env.MORNING_BRIEF_TIME || '08:30',
```

- [ ] **Step 2: Add `scheduleMorningBrief` (clone of `scheduleDailySummary`, ~line 169)**

```js
function scheduleMorningBrief(time) {
    if (!config.companionEnabled) return;
    const [hh, mm] = time.split(':').map(Number);

    function msUntilNextOccurrence() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        return target - now;
    }

    function scheduleNext() {
        const ms = msUntilNextOccurrence();
        logger.info(`Morning brief scheduled at ${time} (in ${(ms / 3600000).toFixed(1)}h)`);
        setTimeout(async () => {
            logger.info('Morning brief pulse triggered');
            try {
                await handler._injectCompanionPrompt(
                    'Run your morning chief-of-staff sweep now (use the chief-of-staff skill).'
                );
            } catch (err) {
                logger.error(`Morning brief pulse failed: ${err.message}`);
            }
            scheduleNext();
        }, ms).unref();
    }

    scheduleNext();
}
```

And call it right after `scheduleDailySummary(config.dailySummaryTime);` (~line 298):

```js
        scheduleMorningBrief(config.morningBriefTime);
```

- [ ] **Step 3: Add `POST /pulse` endpoint in socket.js**

Next to the `POST /daily-summary` route (~6038):

```js
        // Entity: trigger the morning sweep manually. ?dry_run=1 runs the
        // collectors in-process and returns candidates without touching the
        // companion or posting anything.
        httpApp.post('/pulse', async (req, res) => {
            try {
                if (req.query.dry_run === '1') {
                    const { execFile } = require('child_process');
                    const out = await new Promise((resolve, reject) => {
                        execFile('node', [path.join(__dirname, '../../../scripts/collect.js')],
                            { timeout: 60_000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
                    });
                    return res.json(JSON.parse(out));
                }
                await this._injectCompanionPrompt(
                    'Run your morning chief-of-staff sweep now (use the chief-of-staff skill).'
                );
                res.json({ ok: true, injected: true });
            } catch (err) {
                res.status(500).json({ ok: false, error: err.message });
            }
        });
```

(Match the surrounding routes' variable names — the Express app local may be `httpApp` or similar; check the `POST /daily-summary` block and mirror it exactly, including any auth middleware it uses.)

- [ ] **Step 4: Update `.env.example`**

Append:

```bash
# ── Entity companion (Plan B) ─────────────────────────────────────────
# Master switch for the durable owner-DM companion session + morning brief
COMPANION_ENABLED=false
# Companion workspace (persona + chief-of-staff skill); install with
#   node scripts/setup-companion-home.js
COMPANION_HOME=
# Daily chief-of-staff brief time (server-local time, HH:MM)
MORNING_BRIEF_TIME=08:30
# Slack channels swept for owner mentions: name:ID,name:ID
COMPANION_SLACK_CHANNELS=
# Read-scoped credentials for the sweep
GITHUB_TOKEN=
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
```

- [ ] **Step 5: Full suite + end-to-end dry run**

```bash
npm test                                   # all suites PASS
node scripts/collect.js                    # JSON out, errors[] for unconfigured sources
curl -X POST 'http://localhost:9999/pulse?dry_run=1'   # same JSON via HTTP (bot must be running)
```

- [ ] **Step 6: End-to-end wet run (on the VPS, owner watching Slack)**

```bash
# .env: COMPANION_ENABLED=true + creds; then
node scripts/setup-companion-home.js
npm run restart
curl -X POST http://localhost:9999/pulse
```

Expected: companion session `enzobot-companion` appears in tmux; owner receives the Block Kit brief in DM; pressing 💤 on an item snoozes it (verify: `node scripts/agenda-cli.js list` no longer shows it); pressing ▶ makes the companion respond in the DM.

- [ ] **Step 7: Commit and push**

```bash
git add start-slack-socket.js src/channels/slack/socket.js .env.example
git commit -m "Schedule morning brief pulse and add POST /pulse"
git pull --rebase && git push
```

---

## Self-review notes (done at plan time)

- **Spec coverage:** companion durable session (T9), agenda (T1–2), 08:30 pulse + brief + buttons (T7, T8, T11), collectors Slack/GitHub/Jira (T3–5), graceful degradation (T6, skill step 5), `POST /pulse` (T11), personal-messages-never-stored (T3 derives candidates only), persona home (T10, interim until Plan A). Graph enrichment appears as a skill instruction (chief-of-staff step 4) using the existing agent-mem HTTP API — no new code needed in this plan. Deferred to Plans A/C per spec: directives, MCP shim, interrupts, whispers, introspection.
- **Known risk spots called out inline:** exact local variable names inside `_processCommand`'s new-session branch (T9 step 6) and the Express app local (T11 step 3) — both have grep instructions; the executor must adapt to what's actually there, not paste blindly.
- **Type consistency:** candidate shape (`dedupe_key/kind/source_ref/title/evidence`) is identical across collectors → agenda-cli → Agenda.upsert; brief items carry `agenda_id` (from agenda-cli output `id`) → buttons `value` → `handleAgendaAction`.
