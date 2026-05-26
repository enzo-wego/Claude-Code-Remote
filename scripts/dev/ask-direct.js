#!/usr/bin/env node
/**
 * Drive ask_user directly via the in-process MCP server, bypassing Claude.
 * Used to validate Phase 3 question shapes that Opus xhigh refuses to
 * call from the agent side.
 *
 * Usage:
 *   node scripts/dev/ask-direct.js <case> <channel_id> <thread_ts>
 *   node scripts/dev/ask-direct.js all <channel_id> <thread_ts>   # runs confirm,text,preview sequentially
 *
 * Cases:
 *   confirm   — yes/no buttons in-thread (no modal)
 *   text      — multiline free-text via "Open editor" modal
 *   preview   — code-block + Approve/Reject buttons in-thread
 *   wizard    — branching wizard (same payload as wizard-direct.js)
 *   single    — single-select with descriptions (same as Phase 3 test #1)
 *   multi     — 3-question single_modal (same as Phase 3 test #4)
 *   all       — confirm + text + preview, in order, same thread
 */

const path = require('path');
const Database = require('better-sqlite3');

const [, , caseName, channelId, threadTs] = process.argv;
if (!caseName || !channelId || !threadTs) {
    console.error('usage: node scripts/dev/ask-direct.js <case|all> <channel_id> <thread_ts>');
    process.exit(2);
}

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:9998/mcp';
const DB_PATH = path.resolve(__dirname, '../../src/data/slack-sessions.db');

const FIXTURES = {
    confirm: {
        questions: [{
            id: 'apply',
            type: 'confirm',
            question: 'Apply this patch?',
            // omit `buttons` → default Yes/No (primary/danger) injected by normalizeQuestion
        }],
    },
    text: {
        questions: [{
            id: 'note',
            type: 'text',
            question: 'Paste the error message you want me to investigate',
            multiline: true,
            placeholder: 'Stack trace, log line, etc.',
        }],
    },
    preview: {
        questions: [{
            id: 'diff',
            type: 'preview',
            question: 'Apply this diff?',
            language: 'diff',
            body: '+ const PORT = 9998\n- const PORT = 9999\n  console.log(`MCP up on ${PORT}`);',
            buttons: [
                { label: 'Approve', value: 'yes', style: 'primary' },
                { label: 'Reject', value: 'no', style: 'danger' },
            ],
        }],
    },
    single: {
        questions: [{
            id: 'scope',
            type: 'select',
            question: 'Scope of work for this turn?',
            options: [
                { label: 'Plans only', description: 'No code yet.' },
                { label: 'Plans + skeleton (Recommended)', description: 'Branch + stubs.' },
                { label: 'Plans + full PR', description: 'End-to-end.' },
            ],
            allow_custom: true,
        }],
    },
    multi: {
        title: 'Multi-question',
        questions: [
            { id: 'pkg', type: 'select', question: 'Which package?',
              options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }] },
            { id: 'note', type: 'text', question: 'Free-form note', multiline: true },
            { id: 'go', type: 'confirm', question: 'Deploy after?' },
        ],
    },
    wizard: {
        title: 'Branching wizard',
        questions: [
            { id: 'a', type: 'select', question: 'Pick a letter',
              options: [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }] },
            { id: 'b', type: 'text', question: 'Why x?',
              show_if: { question_id: 'a', equals: 'x' } },
            { id: 'c', type: 'text', question: 'Any final note?' },
        ],
    },
};

function plan() {
    if (caseName === 'all') return ['confirm', 'text', 'preview'];
    if (!FIXTURES[caseName]) {
        console.error(`unknown case "${caseName}". valid: ${Object.keys(FIXTURES).join(', ')}, all`);
        process.exit(2);
    }
    return [caseName];
}

async function main() {
    const cases = plan();
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

    for (const c of cases) {
        const sessionKey = `ask-direct-${c}-${Date.now()}`;
        const now = Date.now();
        db.prepare(`
            INSERT INTO sessions
            (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at)
            VALUES (?, 'ask-direct', ?, ?, '/tmp', ?, ?)
        `).run(sessionKey, channelId, threadTs, now, now);
        console.log(`\n[${c}] seed: ${sessionKey} → ${channelId}/${threadTs}`);

        const url = new URL(`${MCP_URL}/${sessionKey}`);
        const transport = new StreamableHTTPClientTransport(url);
        const client = new Client(
            { name: `ask-direct-${c}`, version: '0.0.1' },
            { capabilities: {} },
        );
        await client.connect(transport);
        console.log(`[${c}] mcp connected — drive the modal/buttons in Slack…`);

        let result;
        try {
            result = await client.callTool({ name: 'ask_user', arguments: FIXTURES[c] });
        } finally {
            try {
                db.prepare('DELETE FROM sessions WHERE session_key = ?').run(sessionKey);
            } catch (err) {
                console.warn(`[${c}] cleanup failed: ${err.message}`);
            }
            try { await client.close(); } catch {}
        }

        const payload = result.content?.[0]?.text
            ? JSON.parse(result.content[0].text)
            : result;
        console.log(`[${c}] response:`);
        console.log(JSON.stringify(payload, null, 2));
    }

    db.close();
    console.log('\n[done] all cases complete.');
    process.exit(0);
}

main().catch((err) => {
    console.error('[FATAL]', err.message);
    console.error(err.stack);
    process.exit(1);
});
