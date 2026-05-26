#!/usr/bin/env node
/**
 * Sidestep Claude: call the slack-ask:ask_user MCP tool directly from
 * this server with a wizard-shape payload, so we can validate the
 * Phase 3 wizard machinery end-to-end without depending on a flaky
 * Opus xhigh prompt-following.
 *
 * Usage:
 *   node scripts/dev/wizard-direct.js <channel_id> <thread_ts>
 *
 * Example:
 *   node scripts/dev/wizard-direct.js C0AJ3JPRA9L 1779721269.424299
 *
 * Flow:
 *   1. Inserts a synthetic sessions row (session_key=wizard-test-<ms>).
 *   2. Opens an MCP client against http://127.0.0.1:9998/mcp/<session_key>.
 *   3. Calls ask_user with branching wizard questions.
 *   4. Waits for the user to drive the modal in Slack.
 *   5. Prints {answers, status}, deletes the synthetic row.
 *
 * Requires the bot service to be running with MCP_ENABLED=true.
 */

const path = require('path');
const Database = require('better-sqlite3');

const [, , channelId, threadTs] = process.argv;
if (!channelId || !threadTs) {
    console.error('usage: node scripts/dev/wizard-direct.js <channel_id> <thread_ts>');
    process.exit(2);
}

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:9998/mcp';
const DB_PATH = path.resolve(__dirname, '../../src/data/slack-sessions.db');
const SESSION_KEY = `wizard-test-${Date.now()}`;

async function main() {
    // ── 1. seed a sessions row so ask_user's DB lookup finds the target thread
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    const now = Date.now();
    db.prepare(`
        INSERT INTO sessions
        (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at)
        VALUES (?, 'wizard-direct', ?, ?, '/tmp', ?, ?)
    `).run(SESSION_KEY, channelId, threadTs, now, now);
    console.log(`[seed] sessions row inserted: ${SESSION_KEY} → ${channelId}/${threadTs}`);

    // ── 2. open MCP client
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const url = new URL(`${MCP_URL}/${SESSION_KEY}`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
        { name: 'wizard-direct', version: '0.0.1' },
        { capabilities: {} },
    );
    await client.connect(transport);
    console.log(`[mcp] connected: ${url}`);

    // ── 3. call ask_user with the branching wizard payload
    const args = {
        title: 'Branching wizard',
        questions: [
            {
                id: 'a',
                type: 'select',
                question: 'Pick a letter',
                options: [
                    { label: 'x', value: 'x' },
                    { label: 'y', value: 'y' },
                ],
            },
            {
                id: 'b',
                type: 'text',
                question: 'Why x?',
                show_if: { question_id: 'a', equals: 'x' },
            },
            {
                id: 'c',
                type: 'text',
                question: 'Any final note?',
            },
        ],
    };
    console.log('[mcp] calling ask_user (wizard layout) — waiting for you to drive the modal in Slack…');

    let result;
    try {
        result = await client.callTool({ name: 'ask_user', arguments: args });
    } finally {
        // 5. cleanup the seeded sessions row
        try {
            db.prepare('DELETE FROM sessions WHERE session_key = ?').run(SESSION_KEY);
            console.log(`[cleanup] sessions row deleted: ${SESSION_KEY}`);
        } catch (err) {
            console.warn(`[cleanup] sessions row delete failed: ${err.message}`);
        }
        db.close();
    }

    console.log('[mcp] response:');
    console.log(JSON.stringify(result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error('[FATAL]', err.message);
    console.error(err.stack);
    try {
        const db = new Database(DB_PATH);
        db.prepare('DELETE FROM sessions WHERE session_key = ?').run(SESSION_KEY);
        db.close();
    } catch {}
    process.exit(1);
});
