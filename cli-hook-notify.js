#!/usr/bin/env node

/**
 * CLI Hook Notification Script
 * Called by Claude Code's Stop/SubagentStop hooks AND Codex's notify hook.
 *
 * Logic:
 *  1. Read stdin JSON (Claude) or argv (Codex) — shape sniffed at top
 *  2. Normalize to { last_assistant_message, session_id, transcript_path } shape
 *  3. Get SLACK_SESSION_KEY from env → look up channel/thread in SQLite
 *  4. Post response to the correct Slack thread
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { execSync } = require('child_process');
const { postOncallDoubleCheck } = require('./src/services/oncall-mention');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

// Diagnostic trace log — append every invocation so we can tell whether
// completion hooks (Codex Stop / Gemini AfterAgent) actually fire. Stderr
// from this script goes to the TUI inside tmux and is unrecoverable, which
// makes silent hook failures impossible to debug otherwise.
const TRACE_LOG_PATH = path.join(projectDir, 'cli-hook-notify.log');
function traceLog(stage, extra = {}) {
    try {
        const entry = {
            ts: new Date().toISOString(),
            stage,
            argv: process.argv.slice(2),
            cli_source: process.env.CLI_SOURCE || null,
            session_key: process.env.SLACK_SESSION_KEY || null,
            pid: process.pid,
            ...extra,
        };
        fs.appendFileSync(TRACE_LOG_PATH, JSON.stringify(entry) + '\n');
    } catch (_) { /* silent fail — diagnostics must never break the hook */ }
}
traceLog('entry');
process.on('exit', (code) => traceLog('exit', { code }));

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true, quiet: true });
} else {
    console.error('.env file not found at:', envPath);
    process.exit(1);
}

// Strip any HTTP(S) proxy inherited from the tmux session env. Gemini sessions
// export HTTPS_PROXY/HTTP_PROXY (a US-egress tunnel to bypass the Gemini API
// geo-block — see gemini-adapter.extraLaunchEnv); this hook is spawned as a
// child of that shell and inherits it. But the hook only talks to internal
// infra (PagerDuty REST API, Slack, local SQLite) — routing those through the
// US tunnel made the PagerDuty on-call lookup return 404, so the L1 ping fell
// back to the configured owner instead of the real on-call. Force direct.
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;
delete process.env.NODE_USE_ENV_PROXY;

// Gemini's AfterAgent hook contract reads stdout as JSON to decide whether
// to retry or accept the turn (e.g. `{decision:"deny"}` triggers a retry).
// An empty stdout is treated as a malformed hook and the warning
// "Hook(s) [...] failed" appears in the TUI — and the hook's effects (our
// Slack post) get reported as failed even though the script itself exits 0.
// Emit `{}` once on any exit so Gemini's parser is happy. Harmless for
// Claude/Codex, which don't read hook stdout.
let _stdoutFinalized = false;
function _finalizeHookStdout() {
    if (_stdoutFinalized) return;
    _stdoutFinalized = true;
    try { process.stdout.write('{}\n'); } catch { /* stdout closed */ }
}
process.on('exit', _finalizeHookStdout);
process.on('beforeExit', _finalizeHookStdout);

/**
 * Read JSON from stdin (Claude/Codex both deliver payloads this way, with different shapes).
 */
function readStdin() {
    return new Promise((resolve) => {
        let input = '';
        process.stdin.on('data', (chunk) => input += chunk);
        process.stdin.on('end', () => {
            let parsed = {};
            let parseError = null;
            if (input.trim()) {
                try { parsed = JSON.parse(input); } catch (e) { parseError = e.message; }
            }
            resolve({ parsed, rawLen: input.length, parseError, tty: false });
        });
        if (process.stdin.isTTY) resolve({ parsed: {}, rawLen: 0, parseError: null, tty: true });
    });
}

/**
 * Detect which CLI emitted this hook payload.
 *
 * Priority:
 *  1. CLI_SOURCE env var (set by tmux-helper when we launched the session)
 *  2. Shape sniffing — Codex uses hyphenated keys (last-assistant-message, turn-id),
 *     Claude uses underscored keys (last_assistant_message, session_id).
 *  3. Default to 'claude' for backward compat.
 */
function detectCliSource(hookInput) {
    const envSource = (process.env.CLI_SOURCE || '').toLowerCase();
    if (envSource === 'codex' || envSource === 'claude' || envSource === 'gemini') return envSource;
    if (hookInput && typeof hookInput === 'object') {
        // Gemini's AfterAgent payload uses `prompt_response` (not `last_assistant_message`)
        // and an explicit `hook_event_name: "AfterAgent"` marker. Check before Claude
        // since both share `session_id`.
        if (hookInput.hook_event_name === 'AfterAgent' || 'prompt_response' in hookInput) return 'gemini';
        if ('last-assistant-message' in hookInput || 'turn-id' in hookInput) return 'codex';
        if ('last_assistant_message' in hookInput || 'session_id' in hookInput) return 'claude';
    }
    return 'claude';
}

/**
 * Normalize Codex Stop-hook payload to Claude-shaped input so the rest of the
 * script is CLI-agnostic. Codex emits underscored keys per the docs
 * (https://developers.openai.com/codex/hooks): session_id, turn_id,
 * last_assistant_message, transcript_path. Hyphenated fallbacks are kept for
 * any version that emits them.
 */
function normalizeCodexInput(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
        last_assistant_message: raw.last_assistant_message || raw['last-assistant-message'] || raw.message || '',
        session_id: raw.session_id || raw['session-id'] || raw.turn_id || raw['turn-id'] || null,
        transcript_path: raw.transcript_path || raw['transcript-path'] || null,
        _codex_raw: raw,
    };
}

/**
 * Normalize Gemini AfterAgent payload to Claude shape. Field rename per
 * docs: `prompt_response` → `last_assistant_message`. Underscored keys
 * already match Claude's; session_id and transcript_path pass through.
 */
function normalizeGeminiInput(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
        last_assistant_message: raw.prompt_response || raw.last_assistant_message || '',
        session_id: raw.session_id || null,
        transcript_path: raw.transcript_path || null,
        hook_event_name: raw.hook_event_name || null,
        _gemini_raw: raw,
    };
}

/**
 * For alert sessions (Claude only): scan transcript for the assistant message containing
 * the investigation report. Returns the longest message with "Recommended Action:" marker.
 */
function extractAlertReport(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    let bestReport = null;

    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant' || !entry.message?.content) continue;

            let text = '';
            if (typeof entry.message.content === 'string') {
                text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
                text = entry.message.content
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
            }

            text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
            text = text.replace(/\n{3,}/g, '\n\n').trim();

            const MIN_REPORT_LEN = 500;
            if (text && text.length >= MIN_REPORT_LEN
                && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:?/im.test(text)) {
                if (!bestReport || text.length > bestReport.length) {
                    bestReport = text;
                }
            }
        } catch {
            continue;
        }
    }

    return bestReport;
}

/**
 * Fallback for Gemini AfterAgent: pull the last assistant message from the
 * transcript JSONL when `prompt_response` is empty or contained streaming
 * duplication. Gemini's transcript uses `type: "gemini"` (not "assistant")
 * and a plain string `content` field — different from Claude's shape.
 */
function extractFromGeminiTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== 'gemini' || !entry.content) continue;
            const text = String(entry.content)
                .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (text) return text;
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Fallback for Codex Stop hook: the payload's `last_assistant_message` is
 * sometimes empty (intermediate sub-turn, or recent Codex versions delivering
 * it only on the very last turn). Recover the final assistant text from the
 * rollout JSONL — outer entry `{ timestamp, type, payload }`, where the
 * assistant text lives at `payload.message` whenever `payload.type ===
 * "agent_message"`. We take the LAST such entry.
 */
function extractFromCodexTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    let last = null;
    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
            const p = entry.payload;
            if (p && p.type === 'agent_message' && typeof p.message === 'string') {
                last = p.message;
            }
        } catch {
            continue;
        }
    }
    if (!last) return null;
    return last
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Fallback (Claude-only transcript format): extract the last assistant text message.
 */
function extractFromTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');

    // Walk backwards but stop at the current turn's boundary. A turn starts
    // at the most recent `user` entry whose content is a string (the real
    // human prompt). `user` entries with array content are tool_results and
    // are part of the current turn. Without this scoping, a turn that
    // finishes via tool_use only (no assistant text) would cause us to walk
    // back and return the PREVIOUS turn's assistant text — re-posting it as
    // if it were the new reply.
    for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            continue;
        }

        if (entry.type === 'user' && typeof entry.message?.content === 'string') {
            // Crossed into the previous turn without finding assistant text
            // in this one — the current turn produced no text reply.
            return null;
        }

        if (entry.type !== 'assistant' || !entry.message?.content) continue;

        let text = '';
        if (typeof entry.message.content === 'string') {
            text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
            text = entry.message.content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n');
        }

        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        if (text) return text;
    }

    return null;
}

/**
 * Parse Claude transcript for session stats. Returns null for non-Claude transcripts —
 * Codex stats would need its own extractor once we know the payload shape (see plan §2).
 */
function extractSessionStats(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');
    let totalOutput = 0;
    let model = null;
    let lastInputTokens = 0;
    let lastCacheRead = 0;
    let lastCacheCreation = 0;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant') continue;

            if (entry.message?.model) {
                model = entry.message.model;
            }

            const usage = entry.message?.usage;
            if (usage) {
                totalOutput += usage.output_tokens || 0;
                lastInputTokens = usage.input_tokens || 0;
                lastCacheRead = usage.cache_read_input_tokens || 0;
                lastCacheCreation = usage.cache_creation_input_tokens || 0;
            }
        } catch {
            continue;
        }
    }

    if (!lastInputTokens && !totalOutput) return null;

    let modelShort = model || '';
    const modelMatch = modelShort.match(/claude-(\w+-[\d-]+)/);
    if (modelMatch) modelShort = modelMatch[1];

    const contextTokens = lastInputTokens + lastCacheRead + lastCacheCreation;
    // Claude Code annotates 1M-context model variants with `[1m]` in the id
    // (e.g. `claude-opus-4-7[1m]`). Plain `claude-opus-4-7` runs at the
    // standard 200K window — same divisor OMC HUD uses, so they agree.
    // The old `includes('opus') ? 1M : 200K` heuristic over-counted by 5×
    // for Opus on 200K, producing 4% in Slack vs 21% in the live HUD.
    const contextLimit = /\[1m\]/i.test(model || '') ? 1000000 : 200000;
    const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));

    const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    return {
        model: modelShort,
        context: `${contextPct}%`,
        tokensIn: fmtTokens(lastInputTokens),
        tokensOut: fmtTokens(totalOutput),
    };
}

/**
 * Codex transcript stats. The rollout JSONL carries:
 *  - `turn_context` payload → `model`, `effort`
 *  - `event_msg` payload `type=token_count` → `info.last_token_usage`,
 *    `info.total_token_usage`, `info.model_context_window`
 * We take the LAST token_count event (matches what Codex shows in its footer).
 */
function extractCodexSessionStats(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    let model = null;
    let effort = null;
    let lastTokenInfo = null;

    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
            const p = entry.payload;
            if (entry.type === 'turn_context' && p) {
                if (p.model) model = p.model;
                if (p.effort) effort = p.effort;
            } else if (entry.type === 'event_msg' && p && p.type === 'token_count' && p.info) {
                lastTokenInfo = p.info;
            }
        } catch {
            continue;
        }
    }

    if (!lastTokenInfo) return null;

    const last = lastTokenInfo.last_token_usage || {};
    const total = lastTokenInfo.total_token_usage || {};
    const windowSize = lastTokenInfo.model_context_window || 0;
    const lastTotal = last.total_tokens || 0;
    const contextPct = windowSize > 0
        ? Math.min(100, Math.round((lastTotal / windowSize) * 100))
        : 0;

    const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);

    return {
        model: effort ? `${model} ${effort}` : (model || ''),
        context: `${contextPct}%`,
        tokensIn: fmtTokens(last.input_tokens || 0),
        tokensOut: fmtTokens(total.output_tokens || 0),
    };
}

/**
 * Gemini stats footer. Per product convention, Gemini sessions show only
 * the model identifier "Auto (Gemini 3)" — no Ctx / In / Out figures —
 * because the gemini-cli surfaces an aggregated "auto" routing label rather
 * than a single stable model name. Returning only `model` lets formatStatsLine
 * skip the missing fields cleanly.
 */
function extractGeminiSessionStats(/* transcriptPath */) {
    return { model: 'Auto (Gemini 3)' };
}

/**
 * Build the italicized stats footer line, skipping any field the extractor
 * didn't populate. Claude/Codex return all four (model, context, tokensIn,
 * tokensOut); Gemini returns only model.
 */
function formatStatsLine(stats) {
    if (!stats) return '';
    const parts = [];
    if (stats.model) parts.push(stats.model);
    if (stats.context) parts.push(`Ctx: ${stats.context}`);
    if (stats.tokensIn) parts.push(`In: ${stats.tokensIn}`);
    if (stats.tokensOut) parts.push(`Out: ${stats.tokensOut}`);
    return parts.length > 0 ? `_${parts.join(' · ')}_` : '';
}

/**
 * Send a response to Slack, splitting into chunks if needed.
 * Appends session stats (model, context, tokens) to the last chunk when available.
 */
async function sendResponse(web, channelId, threadTs, response, stats, mentionUserId = null) {
    const maxLen = 2990;
    const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
    const prefix = `:black_circle_for_record: ${mention}`;
    const statsLine = formatStatsLine(stats);

    const firstChunkMax = maxLen - prefix.length;

    if (response.length <= firstChunkMax) {
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: prefix + response } }
        ];
        if (statsLine) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
        }
        await web.chat.postMessage({
            channel: channelId,
            text: response,
            blocks,
            thread_ts: threadTs
        });
    } else {
        const chunks = [];
        chunks.push(response.substring(0, firstChunkMax));
        for (let i = firstChunkMax; i < response.length; i += maxLen) {
            chunks.push(response.substring(i, i + maxLen));
        }
        for (let i = 0; i < chunks.length; i++) {
            const text = (i === 0 ? prefix : '') + chunks[i];
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text } }
            ];
            if (i === chunks.length - 1 && statsLine) {
                blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
            }
            await web.chat.postMessage({
                channel: channelId,
                text: chunks[i],
                blocks,
                thread_ts: threadTs
            });
        }
    }
}

/**
 * Mirror socket.js `_updateLastBotTs` from the hook side. Without this, the
 * poller's tmux-died branch sees `last_bot_ts IS NULL` even after the hook
 * posted a real report and misclassifies a clean session exit as
 * "started work but did not finish".
 */
function updateLastBotTs(slackSessionKey) {
    if (!slackSessionKey) return;
    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');
        if (!fs.existsSync(dbPath)) return;
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        const nowTs = String(Date.now() / 1000);
        db.prepare(
            'UPDATE sessions SET last_bot_ts = ?, updated_at = ? WHERE session_key = ?'
        ).run(nowTs, Date.now(), slackSessionKey);
        db.close();
    } catch (err) {
        console.error(`Failed to update last_bot_ts: ${err.message}`);
    }
}

/**
 * True if the session's thread-root message still exists. If the user deleted
 * the message that spawned the session, posting into its thread_ts silently
 * lands at the channel root (orphaned) — so we check first and skip the post.
 *
 * Uses conversations.history (Slack omits deleted messages from it) rather than
 * conversations.replies, which returns thread_not_found for a perfectly valid
 * message that simply has no replies yet — that would false-positive on the
 * first post of every session. On any API error we assume it exists: better to
 * post a possibly-orphaned message than to wrongly tear down a healthy session.
 */
async function threadRootExists(web, channelId, threadTs) {
    try {
        const res = await web.conversations.history({
            channel: channelId,
            latest: threadTs,
            oldest: threadTs,
            inclusive: true,
            limit: 1,
        });
        return Array.isArray(res.messages) && res.messages.some(m => m.ts === threadTs);
    } catch (err) {
        console.error(`Thread-root existence check failed: ${err.message}`);
        return true;
    }
}

/**
 * Tear down a session whose thread root was deleted: drop the DB row and kill
 * its tmux session so it stops re-posting into the void on the next turn. The
 * row delete happens first so state is clean even if killing our own tmux pane
 * takes this hook process down with it. (MCP config cleanup is left to the
 * bot's socket-side reaper — this is a best-effort backstop.)
 */
function reapDeadThreadSession(slackSessionKey, sessionName) {
    if (slackSessionKey) {
        try {
            const Database = require('better-sqlite3');
            const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');
            if (fs.existsSync(dbPath)) {
                const db = new Database(dbPath);
                db.pragma('journal_mode = WAL');
                db.prepare('DELETE FROM sessions WHERE session_key = ?').run(slackSessionKey);
                db.close();
            }
        } catch (err) {
            console.error(`Failed to delete dead-thread session row ${slackSessionKey}: ${err.message}`);
        }
    }
    if (sessionName) {
        // execFileSync (no shell) — sessionName is bot-generated, but args-array
        // form keeps this injection-free regardless. stdio:'ignore' swallows the
        // "session not found" noise when the pane is already gone.
        try {
            const { execFileSync } = require('child_process');
            execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
        } catch { /* already gone, or our pane was torn down first */ }
    }
}

function markAlertQueueComplete(channelId, alertMessageTs) {
    if (!channelId || !alertMessageTs) return;
    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');
        if (!fs.existsSync(dbPath)) return;
        const db = new Database(dbPath);
        const result = db.prepare(
            "UPDATE alert_queue SET status = 'completed', updated_at = ? " +
            "WHERE channel_id = ? AND message_ts = ? AND status = 'processing'"
        ).run(Date.now(), channelId, alertMessageTs);
        db.close();
        if (result.changes > 0) {
            console.error(`Alert queue: freed slot for channel=${channelId} ts=${alertMessageTs}`);
            kickQueue();
        }
    } catch (err) {
        console.error(`Failed to free alert queue slot: ${err.message}`);
    }
}

function kickQueue() {
    try {
        const port = process.env.SLACK_HTTP_PORT || 9999;
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/queue/kick',
            method: 'POST',
            timeout: 2000,
        });
        req.on('error', () => {});
        req.end();
    } catch {}
}

/**
 * Relay a built-in AskUserQuestion picker to Slack. Fired from the
 * PreToolUse:AskUserQuestion hook (see claude-adapter installHooks). The picker
 * renders only in the local TUI, fires no Stop hook, and blocks the turn — so
 * this is the one chance to surface the question to the remote owner. The
 * caller exits 0 with no stdout, so this never blocks or alters the tool.
 */
async function relayAskUserQuestion(hookInput, rawInput, slackSessionKey) {
    const toolInput = (hookInput && hookInput.tool_input) || (rawInput && rawInput.tool_input) || {};
    const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    if (!questions.length) {
        console.error('ask-question: no questions in tool_input — skipping');
        return;
    }

    let channelId = null;
    let threadTs = null;
    let lastUserId = null;
    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');
        if (!fs.existsSync(dbPath)) return;
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(slackSessionKey);
        db.close();
        if (!row) {
            console.error(`ask-question: no session row for key=${slackSessionKey}`);
            return;
        }
        channelId = row.channel_id;
        threadTs = row.thread_ts;
        lastUserId = row.last_user_id || null;
    } catch (err) {
        console.error(`ask-question: DB lookup failed: ${err.message}`);
        return;
    }

    if (!channelId || !threadTs) {
        console.error('ask-question: session row missing channel/thread');
        return;
    }
    if (!process.env.SLACK_BOT_TOKEN) {
        console.error('ask-question: SLACK_BOT_TOKEN not configured');
        return;
    }

    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(process.env.SLACK_BOT_TOKEN);

    // Don't post into a thread whose root was deleted — it would orphan at the
    // channel root. If the check itself errors, fall through and try the post.
    try {
        if (!(await threadRootExists(web, channelId, threadTs))) {
            console.error(`ask-question: thread root ${threadTs} gone in ${channelId} — skipping`);
            return;
        }
    } catch { /* best-effort */ }

    // The assistant prose printed just above the picker (e.g. a plan summary).
    // At PreToolUse time the picker's tool_use entry carries no text block, so
    // extractFromTranscript returns this preceding narration — the turn's text.
    let prose = null;
    try { prose = extractFromTranscript(hookInput.transcript_path); } catch { /* best-effort */ }

    const parts = [];
    parts.push(':raising_hand: *Claude needs your input* — reply in this thread with the option number(s) or your own text.');
    if (prose) parts.push(prose);
    for (const q of questions) {
        const lines = [];
        if (q && q.question) lines.push(`*${q.question}*`);
        const opts = Array.isArray(q && q.options) ? q.options : [];
        opts.forEach((opt, i) => {
            const label = opt && opt.label ? opt.label : `Option ${i + 1}`;
            const desc = opt && opt.description ? ` — ${opt.description}` : '';
            lines.push(`   ${i + 1}. *${label}*${desc}`);
        });
        if (q && q.multiSelect) lines.push('_(you can choose more than one)_');
        if (lines.length) parts.push(lines.join('\n'));
    }
    const message = parts.join('\n\n');

    await sendResponse(web, channelId, threadTs, message, null, lastUserId);
    updateLastBotTs(slackSessionKey);
    console.error(`ask-question: relayed ${questions.length} question(s) to ${channelId}/${threadTs}`);
}

async function sendHookNotification() {
    const notificationType = process.argv[2] || 'completed';
    const currentDir = process.cwd();
    const projectName = path.basename(currentDir);

    const stdinResult = await readStdin();
    const rawInput = stdinResult.parsed;
    const cliSource = detectCliSource(rawInput);
    let hookInput;
    if (cliSource === 'codex') hookInput = normalizeCodexInput(rawInput);
    else if (cliSource === 'gemini') hookInput = normalizeGeminiInput(rawInput);
    else hookInput = rawInput;

    // Diagnostic: capture the inbound payload shape so we can tell whether
    // an empty-stdin invocation is causing the hook to silently exit before
    // it can post (e.g. Codex's multi-hook Stop chain starving stdin for the
    // last hook in the list). One line per invocation alongside entry/exit.
    traceLog('payload', {
        stdin_bytes: stdinResult.rawLen,
        stdin_tty: stdinResult.tty,
        stdin_parse_error: stdinResult.parseError,
        raw_keys: Object.keys(rawInput || {}),
        transcript_path: hookInput.transcript_path || null,
        last_msg_len: (hookInput.last_assistant_message || '').length,
        session_id: hookInput.session_id || null,
    });

    const slackSessionKey = process.env.SLACK_SESSION_KEY;
    if (!slackSessionKey) {
        process.exit(0);
    }

    // ─── UserPromptSubmit: drop a "turn started" marker, never post ──
    // Fires the instant Claude accepts a submitted prompt, before it runs.
    // socket.js _verifyTurnProgress reads this marker as the authoritative
    // proof that the injected paste + Enter was accepted — far stronger than
    // scraping the TUI for a spinner. Mirror of the post-completion marker
    // below (/tmp/cli-hook-post-<key>); keyed by SLACK_SESSION_KEY so the
    // verifier can match it to this specific inject.
    if (notificationType === 'prompt-submitted') {
        try {
            fs.writeFileSync(`/tmp/cli-hook-prompt-${slackSessionKey}`, String(Date.now()));
            console.error(`UserPromptSubmit — wrote turn-start marker for key=${slackSessionKey}`);
        } catch (err) {
            console.error(`UserPromptSubmit marker write failed: ${err.message}`);
        }
        process.exit(0);
    }

    // ─── SubagentStop: never post to Slack ──────────────────────────
    // SubagentStop fires when Claude finishes an internal sub-agent (e.g. the
    // Task tool, or the next-action / ghost-text suggester). The sub-agent's
    // last_assistant_message is internal scratch (we observed it leaking the
    // input-box ghost-text "switch to main" to Slack). The Stop hook posts
    // the canonical user-facing assistant message; SubagentStop output is not
    // meant to reach Slack at all.
    if (notificationType === 'waiting') {
        console.error('SubagentStop (waiting) — skipping post, sub-agent output is internal');
        process.exit(0);
    }

    // ─── SessionStart: register session_id in DB ─────────────────────
    // (Claude/Gemini — Codex's notify hook doesn't have a session_start equivalent.)
    if (notificationType === 'session_start') {
        const sessionId = hookInput.session_id;
        if (!sessionId || !slackSessionKey) {
            process.exit(0);
        }

        try {
            const Database = require('better-sqlite3');
            const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');

            if (fs.existsSync(dbPath)) {
                const db = new Database(dbPath);
                db.pragma('journal_mode = WAL');
                // Overwrite unconditionally (NOT COALESCE): in a CLI fallback
                // chain (e.g. gemini -> codex -> claude), the earlier CLI's
                // SessionStart already stamped its own session_id here. COALESCE
                // would keep that stale id, so when the CLI that actually runs
                // (claude) finishes, its real Stop session_id wouldn't match the
                // stored "root" and the alert-post path would wrongly treat the
                // final report as an internal subagent turn and skip it. The
                // latest SessionStart is the live session, so it must win.
                const result = db.prepare(
                    'UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE session_key = ?'
                ).run(sessionId, Date.now(), slackSessionKey);
                db.close();
                console.error(`SessionStart: mapped session_id=${sessionId} to key=${slackSessionKey} (rows=${result.changes})`);
            }
        } catch (error) {
            console.error('SessionStart DB update failed:', error.message);
        }

        process.exit(0);
    }

    // ─── PreToolUse:AskUserQuestion: relay the interactive picker ────
    // The built-in AskUserQuestion picker renders only in the local TUI,
    // suspends the turn waiting for a pick, and fires NO Stop hook — so the
    // question never reaches Slack via the completed path. This event carries
    // the full structured question + options in `tool_input`; relay it so the
    // remote owner can answer from the thread. Side-effect only: we exit 0 with
    // no stdout so the tool proceeds and still shows its picker locally.
    if (notificationType === 'ask-question') {
        try {
            await relayAskUserQuestion(hookInput, rawInput, slackSessionKey);
        } catch (err) {
            console.error(`ask-question relay failed: ${err.message}`);
        }
        process.exit(0);
    }

    // ─── Stop/SubagentStop: resolve session from DB ──────────────────
    let channelId = process.env.SLACK_CHANNEL_ID;
    let threadTs = undefined;
    let isAlertSession = false;
    let alertMessageTs = null;
    let lastUserId = null;
    let rootSessionId = null;
    let sessionName = null;

    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');

        if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath, { readonly: true });
            let row = null;

            if (slackSessionKey) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE session_key = ?'
                ).get(slackSessionKey);
                if (row) {
                    console.error(`Resolved via SLACK_SESSION_KEY=${slackSessionKey}`);
                }
            }

            if (!row && hookInput.session_id) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1'
                ).get(hookInput.session_id);
                if (row) {
                    console.error(`Resolved via session_id=${hookInput.session_id}`);
                }
            }

            db.close();

            if (row) {
                channelId = row.channel_id;
                threadTs = row.thread_ts;
                isAlertSession = !!row.alert_message_ts;
                alertMessageTs = row.alert_message_ts || null;
                lastUserId = row.last_user_id || null;
                rootSessionId = row.claude_session_id || null;
                sessionName = row.session_name || null;

                // Capture Codex's session_id on the first Stop where we see one.
                // Codex has no SessionStart-equivalent hook, so the very first Stop
                // is our only chance to learn the id. Read it from the raw payload
                // (not the normalized one — normalize falls back to turn_id, which
                // changes every turn and would overwrite the persistent id).
                // Skip Claude here; its SessionStart hook owns this column.
                //
                // Overwrite a stale id from a different CLI in the fallback chain:
                // if gemini was tried first and its session_start populated this
                // column, the value is stale once the bot fell back to codex.
                // Codex's session_id is stable per session, so the worst case of
                // overwriting on every codex Stop is a no-op same-value write.
                if (cliSource === 'codex' && row.cli_type === 'codex') {
                    const codexSessionId = rawInput && (rawInput.session_id || rawInput['session-id']);
                    if (codexSessionId && codexSessionId !== row.claude_session_id) {
                        try {
                            const dbWrite = new Database(dbPath);
                            dbWrite.pragma('journal_mode = WAL');
                            const result = dbWrite.prepare(
                                'UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE session_key = ?'
                            ).run(codexSessionId, Date.now(), slackSessionKey);
                            dbWrite.close();
                            if (result.changes > 0) {
                                rootSessionId = codexSessionId;
                                console.error(`Codex session_id=${codexSessionId} captured on Stop for key=${slackSessionKey} (replaced=${row.claude_session_id || 'null'})`);
                            }
                        } catch (writeErr) {
                            console.error('Codex session_id capture failed:', writeErr.message);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('DB lookup failed:', error.message);
    }

    if (!channelId || !threadTs) {
        console.error('No session found — cannot post to Slack');
        process.exit(0);
    }

    if (!process.env.SLACK_BOT_TOKEN) {
        console.error('SLACK_BOT_TOKEN not configured');
        process.exit(1);
    }

    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(process.env.SLACK_BOT_TOKEN);

    let assistantMessage = hookInput.last_assistant_message
        || (cliSource === 'claude' ? extractFromTranscript(hookInput.transcript_path) : null)
        || (cliSource === 'codex'  ? extractFromCodexTranscript(hookInput.transcript_path) : null)
        || (cliSource === 'gemini' ? extractFromGeminiTranscript(hookInput.transcript_path) : null);

    // Gemini's `prompt_response` payload often arrives with runs of whitespace-only
    // lines (e.g. "\n \n \n \n") between mention and content — those don't go
    // through the transcript extractor's `\n{3,}` collapse because each blank
    // line carries a space. Normalize at the central point so every downstream
    // path (alert post, conversation reply, regular chat) sees clean text.
    if (assistantMessage) {
        assistantMessage = String(assistantMessage)
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .replace(/(?:[ \t]*\n){3,}/g, '\n\n')
            .trim();
    }

    let stats;
    if (cliSource === 'codex') stats = extractCodexSessionStats(hookInput.transcript_path);
    else if (cliSource === 'gemini') stats = extractGeminiSessionStats(hookInput.transcript_path);
    else stats = extractSessionStats(hookInput.transcript_path);

    if (assistantMessage && threadTs) {
        try {
            // If the user deleted the message that spawned this session, the
            // thread root is gone and a post would silently orphan at the
            // channel root. Don't post — tear the session down (DB row + tmux)
            // so it stops generating turns and re-posting into the void.
            if (!(await threadRootExists(web, channelId, threadTs))) {
                console.error(`Thread root ${threadTs} gone in ${channelId} — skipping post and reaping ${slackSessionKey}`);
                reapDeadThreadSession(slackSessionKey, sessionName);
                return;
            }
            if (isAlertSession) {
                if (notificationType !== 'completed') {
                    console.error(`Alert session: skipping ${notificationType} (only post on completed)`);
                    return;
                }

                // Subagent skip is Claude-only: SubagentStop hooks fire with a
                // child session_id that differs from the root, and we don't want
                // those internal turns posting to the alert thread. Codex and
                // Gemini have no nested-session concept — their Stop's session_id
                // is always the root, so applying this check there causes a
                // false-positive skip whenever a previous CLI's session_id is
                // still sitting in claude_session_id from a failed fallback.
                if (cliSource === 'claude' && rootSessionId && hookInput.session_id && hookInput.session_id !== rootSessionId) {
                    console.error(`Alert session: skipping Stop from subagent (hook=${hookInput.session_id}, root=${rootSessionId})`);
                    return;
                }

                // Stash file pattern used to recover state across hook invocations
                // (each Stop hook spawns a fresh node process, so /tmp is our memory):
                //   hook-primary-<key>  JSON { ts, fileId } — the canonical alert post
                //   hook-warning-<key>  ts of an "AI agent unresponsive" warning, if any
                //   hook-retry-<key>    nudge retry counter
                const primaryFile = `/tmp/hook-primary-${slackSessionKey}`;
                const warningFile = `/tmp/hook-warning-${slackSessionKey}`;
                const retryFile = `/tmp/hook-retry-${slackSessionKey}`;
                //   hook-firststop-<key>  ts (ms) of the first report-less Stop —
                //   used to gate the "unresponsive" warning on real wall-clock, so a
                //   legit long sub-agent run can't burn the nudge budget on a few
                //   narration Stops and trip a false alarm in the first ~2 minutes.
                const firstStopFile = `/tmp/hook-firststop-${slackSessionKey}`;

                let primary = null;
                try { primary = JSON.parse(fs.readFileSync(primaryFile, 'utf-8')); } catch { /* no prior primary */ }

                // Cold-start recovery: if the stash is empty (service restart, /tmp
                // cleanup), scan the thread for our earlier primary post so we still
                // dedupe instead of posting a second alert block.
                if (!primary) {
                    try {
                        const replies = await web.conversations.replies({
                            channel: channelId, ts: threadTs, limit: 50,
                        });
                        const existing = (replies.messages || []).find(m =>
                            m.ts !== threadTs && typeof m.text === 'string' && m.text.startsWith('Recommended Action:')
                        );
                        if (existing) {
                            primary = { ts: existing.ts, fileId: null };
                            console.error(`Recovered primary from Slack thread: ts=${existing.ts}`);
                        }
                    } catch { /* proceed without recovery */ }
                }

                // Conversation mode: once a human has replied in-thread after the
                // primary investigation post, the alert has transitioned from
                // "single investigation that may be refined" into a Q&A discussion.
                // Stop overwriting the primary post on every agent turn — post the
                // agent's answer as a plain threaded reply instead.
                if (primary && primary.ts && assistantMessage) {
                    let userRepliedAfter = false;
                    try {
                        const replies = await web.conversations.replies({
                            channel: channelId, ts: threadTs, limit: 100,
                        });
                        const primaryTsNum = parseFloat(primary.ts);
                        userRepliedAfter = (replies.messages || []).some(m =>
                            !m.bot_id && m.ts !== threadTs && parseFloat(m.ts) > primaryTsNum
                        );
                    } catch { /* on lookup failure, fall back to alert-format path */ }

                    if (userRepliedAfter) {
                        // Slack chat.postMessage caps at 40k chars. Trim defensively;
                        // the conversational answer is usually well under that.
                        const MAX_TEXT = 39000;
                        const mention = lastUserId ? `<@${lastUserId}> ` : '';
                        const body = assistantMessage.length > MAX_TEXT
                            ? assistantMessage.slice(0, MAX_TEXT) + '\n\n…(truncated)'
                            : assistantMessage;
                        const text = mention + body;
                        try {
                            const post = await web.chat.postMessage({
                                channel: channelId,
                                thread_ts: threadTs,
                                text,
                            });
                            console.error(`Alert in conversation mode — posted plain reply ts=${post.ts}`);
                            try {
                                fs.writeFileSync(`/tmp/cli-hook-post-${slackSessionKey}`, String(Date.now()));
                            } catch { /* ignore */ }
                            updateLastBotTs(slackSessionKey);
                        } catch (err) {
                            console.error(`Conversation-mode post failed: ${err.message}`);
                        }
                        return;
                    }
                }

                let hasValidReport = false;
                if (cliSource === 'claude' && hookInput.transcript_path) {
                    const report = extractAlertReport(hookInput.transcript_path);
                    if (report) {
                        console.error(`Alert report found in transcript (${report.length} chars), overriding last_assistant_message (${(assistantMessage || '').length} chars)`);
                        assistantMessage = report;
                        hasValidReport = true;
                    }
                }

                if (!hasValidReport && assistantMessage && assistantMessage.length >= 500
                    && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:?/im.test(assistantMessage)) {
                    hasValidReport = true;
                }

                // Gemini doesn't follow the alert-skill `Recommended Action:` contract,
                // so a strict regex gate would silently drop every Gemini alert reply.
                // Accept any non-trivial agent response; the summary extractor below
                // falls back to the first 500 chars when the heading is absent.
                if (!hasValidReport && cliSource === 'gemini' && assistantMessage && assistantMessage.length >= 200) {
                    hasValidReport = true;
                }

                if (hasValidReport) {
                    try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
                    try { fs.unlinkSync(firstStopFile); } catch { /* ignore */ }
                    // Colon is optional: the alert skill / nudge produces a
                    // `## Recommended Action` heading (no colon), which renders
                    // without a trailing `:`. Accept both heading and label forms.
                    const headRe = /(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:?\s*/i;
                    const match = assistantMessage.match(new RegExp(headRe.source + '([\\s\\S]*?)(?:\\n\\s*---|\\n\\n##|\\n\\n\\*\\*)', 'i'));
                    const summary = match ? match[1].trim() : (
                        assistantMessage.match(new RegExp(headRe.source + '(.+(?:\\n(?!\\n).+)*)', 'i'))?.[1]?.trim()
                        || assistantMessage.substring(0, 500).trim()
                    );

                    const maxSummaryLen = 2970;
                    const trimmedSummary = summary.length > maxSummaryLen
                        ? summary.substring(0, maxSummaryLen) + '…' : summary;
                    const alertBlocks = [
                        { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${trimmedSummary}` } }
                    ];
                    if (stats) {
                        const statsLine = formatStatsLine(stats);
                        if (statsLine) {
                            alertBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
                        }
                    }

                    // Attachment is the "attachment zone" — everything after the first
                    // `---` separator (skill's two-zone format). Summary is already in
                    // the inline post above; including it again duplicates the heading.
                    const sepMatch = assistantMessage.match(/\n\s*---\s*\n/);
                    const attachmentZone = sepMatch
                        ? assistantMessage.slice(sepMatch.index + sepMatch[0].length).trim()
                        : assistantMessage;

                    let postedTs = null;
                    const isUpdate = !!(primary && primary.ts);

                    // Dedup: extractAlertReport() re-scans the whole transcript on
                    // every Stop and re-surfaces the SAME longest report, so an agent
                    // that keeps running (e.g. OMC /loop) would re-trigger an update +
                    // file delete + re-upload on every narration turn. Skip entirely
                    // when the report content is byte-identical to what we last posted.
                    const reportHash = crypto.createHash('sha1').update(assistantMessage).digest('hex');
                    if (isUpdate && primary.hash && primary.hash === reportHash) {
                        console.error(`Report unchanged (hash ${reportHash.slice(0, 8)}) — skipping redundant update/re-upload`);
                        return;
                    }

                    if (isUpdate) {
                        // Claude refined its answer on a later turn. Overwrite the
                        // existing post in-place so the thread shows one clean message
                        // instead of competing reports.
                        try {
                            await web.chat.update({
                                channel: channelId,
                                ts: primary.ts,
                                text: `Recommended Action: ${summary}`,
                                blocks: alertBlocks,
                            });
                            postedTs = primary.ts;
                            console.error(`Updated primary alert post ts=${primary.ts} with refined report`);
                        } catch (err) {
                            console.error(`chat.update failed (ts=${primary.ts}): ${err.message} — leaving primary as-is`);
                        }

                        if (postedTs && primary.fileId) {
                            try { await web.files.delete({ file: primary.fileId }); } catch (err) {
                                console.error(`files.delete failed (${primary.fileId}): ${err.message}`);
                            }
                        }
                    }

                    if (!postedTs) {
                        const postResult = await web.chat.postMessage({
                            channel: channelId,
                            text: `Recommended Action: ${summary}`,
                            thread_ts: threadTs,
                            blocks: alertBlocks,
                        });
                        postedTs = postResult?.ts || null;
                    }

                    let uploadedFileId = null;
                    try {
                        const uploadResult = await web.filesUploadV2({
                            channel_id: channelId,
                            thread_ts: threadTs,
                            content: attachmentZone,
                            filename: `alert-investigation-${Date.now()}.md`,
                            title: 'Full Investigation Report',
                            initial_comment: isUpdate ? '_Updated investigation attached._' : '_Full investigation details attached._',
                        });
                        uploadedFileId = uploadResult?.files?.[0]?.id
                            || uploadResult?.files?.[0]?.files?.[0]?.id
                            || uploadResult?.file?.id
                            || null;
                        // filesUploadV2 can return ok + a file id while the async
                        // share-to-thread step fails silently (file exists but never
                        // appears in the channel — seen 2026-07-01 on Q2OJQ9USBDKR6O).
                        // Record the id + share state so that case is diagnosable.
                        const uploadedFile = uploadResult?.files?.[0]?.files?.[0] || uploadResult?.files?.[0] || uploadResult?.file || null;
                        traceLog('upload_result', {
                            upload: 'alert-investigation',
                            file_id: uploadedFileId,
                            shares: uploadedFile?.shares ? Object.keys(uploadedFile.shares).length : 0,
                            content_bytes: Buffer.byteLength(attachmentZone || ''),
                            channel_id: channelId,
                            thread_ts: threadTs,
                        });
                    } catch (err) {
                        console.error(`filesUploadV2 failed: ${err.message}`);
                        traceLog('upload_error', {
                            upload: 'alert-investigation',
                            error: err.message,
                            slack_error: err.data?.error || null,
                            content_bytes: Buffer.byteLength(attachmentZone || ''),
                            channel_id: channelId,
                            thread_ts: threadTs,
                        });
                    }

                    if (postedTs) {
                        try {
                            fs.writeFileSync(primaryFile, JSON.stringify({ ts: postedTs, fileId: uploadedFileId, hash: reportHash }));
                        } catch (err) {
                            console.error(`Failed to persist primary stash: ${err.message}`);
                        }
                        updateLastBotTs(slackSessionKey);
                    }

                    // Clean up any stale "AI agent unresponsive" warning posted earlier
                    // — once we have a real report, the human-check prompt is obsolete.
                    try {
                        const warningTs = fs.readFileSync(warningFile, 'utf-8').trim();
                        if (warningTs) {
                            try { await web.chat.delete({ channel: channelId, ts: warningTs }); } catch (err) {
                                console.error(`chat.delete (warning ts=${warningTs}) failed: ${err.message}`);
                            }
                        }
                        fs.unlinkSync(warningFile);
                    } catch { /* no warning posted */ }

                    markAlertQueueComplete(channelId, alertMessageTs);

                    // Post the L1 on-call ping at most once per alert. The bot
                    // service's poller and this hook race to mark the queue
                    // 'completed', so we cannot rely on markAlertQueueComplete's
                    // changes count for "first time" — instead we use an atomic
                    // stash-file claim (`wx` flag = create-or-fail). Same pattern
                    // as primaryFile/warningFile above.
                    const pingMarkerFile = `/tmp/hook-l1ping-${slackSessionKey}`;
                    let claimedPing = false;
                    try {
                        fs.writeFileSync(pingMarkerFile, String(Date.now()), { flag: 'wx' });
                        claimedPing = true;
                    } catch (err) {
                        if (err.code !== 'EEXIST') {
                            console.error(`L1 ping: failed to claim marker ${pingMarkerFile}: ${err.message} — skipping ping`);
                        }
                    }
                    if (claimedPing) {
                        try {
                            await postOncallDoubleCheck({
                                web,
                                dbPath: path.join(projectDir, 'src/data/slack-sessions.db'),
                                channelId,
                                threadTs,
                                alertMessageTs,
                                pagerdutyApiToken: process.env.PAGERDUTY_API_TOKEN,
                                ownerUserId: process.env.SLACK_OWNER_USER_ID,
                            });
                        } catch (err) {
                            console.error(`postOncallDoubleCheck threw unexpectedly: ${err.message}`);
                        }
                    }
                } else {
                    // No valid report on this Stop.
                    // If we already have a primary posted, the user has a clean answer —
                    // stop nudging, stop warning. Subsequent short turns are usually just
                    // the agent narrating between async tool callbacks.
                    if (primary && primary.ts) {
                        console.error(`No valid report in this turn, primary already posted (ts=${primary.ts}) — silent exit`);
                        return;
                    }

                    const HOOK_MAX_RETRIES = parseInt(process.env.HOOK_MAX_RETRIES, 10) || 3;
                    let retryCount = 0;
                    try { retryCount = parseInt(fs.readFileSync(retryFile, 'utf-8').trim(), 10) || 0; } catch { /* first attempt */ }

                    // Stamp the first report-less Stop so the warning below can be
                    // gated on real elapsed time, not on how many narration Stops the
                    // agent happened to emit while a sub-agent was legitimately busy.
                    try { fs.writeFileSync(firstStopFile, String(Date.now()), { flag: 'wx' }); } catch { /* already stamped */ }

                    let tmuxAlive = false;
                    if (sessionName) {
                        try {
                            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
                            tmuxAlive = true;
                        } catch { /* session dead */ }
                    }

                    if (tmuxAlive && retryCount < HOOK_MAX_RETRIES) {
                        retryCount++;
                        fs.writeFileSync(retryFile, String(retryCount));
                        console.error(`Alert incomplete (attempt ${retryCount}/${HOOK_MAX_RETRIES}) — nudging CLI in tmux ${sessionName}`);
                        const nudge = 'Please continue the investigation. Output your final report with a "## Recommended Action" section summarizing what happened and what to do.';
                        try {
                            const nudgeTmp = `/tmp/hook-nudge-${Date.now()}.txt`;
                            fs.writeFileSync(nudgeTmp, nudge);
                            execSync(`tmux load-buffer ${nudgeTmp} && tmux paste-buffer -t ${sessionName}`);
                            execSync(`sleep 0.3 && tmux send-keys -t ${sessionName} Enter`);
                            fs.unlinkSync(nudgeTmp);
                        } catch (err) {
                            console.error(`Failed to nudge CLI in tmux: ${err.message}`);
                        }
                        process.exit(0);
                    }

                    if (tmuxAlive) {
                        // Retries exhausted but the session is still alive. Before
                        // declaring the agent "unresponsive", require a real wall-clock
                        // floor since the first report-less Stop — a legit sub-agent run
                        // (e.g. a 6-7 min DB investigation) emits several short narration
                        // Stops that can burn all nudges in ~2 minutes while real work is
                        // still in flight. Stay silent until the floor passes; the agent
                        // may still produce a report, and if tmux dies the definitive
                        // "incomplete" notice below still fires.
                        const HOOK_MIN_WALL_MS = parseInt(process.env.HOOK_MIN_WALL_MS, 10) || 10 * 60 * 1000;
                        let firstStopAt = 0;
                        try { firstStopAt = parseInt(fs.readFileSync(firstStopFile, 'utf-8').trim(), 10) || 0; } catch { /* unstamped */ }
                        const elapsed = firstStopAt ? Date.now() - firstStopAt : 0;
                        if (firstStopAt && elapsed < HOOK_MIN_WALL_MS) {
                            console.error(`Retries exhausted but only ${Math.round(elapsed / 1000)}s elapsed (floor ${Math.round(HOOK_MIN_WALL_MS / 1000)}s) — agent likely still working, staying silent`);
                            return;
                        }

                        // Retries exhausted but the session is still alive. The AI agent
                        // may be waiting on async tool callbacks (Monitor, background
                        // Bash) and could still produce a report. Post a single
                        // human-check warning, then silently exit on subsequent Stops —
                        // don't reset the counter and don't keep nudging.
                        let alreadyWarned = false;
                        try { fs.accessSync(warningFile); alreadyWarned = true; } catch { /* first warn */ }
                        if (alreadyWarned) {
                            console.error(`Retries exhausted, tmux alive, warning already posted — silent exit`);
                            return;
                        }

                        try {
                            const warnResult = await web.chat.postMessage({
                                channel: channelId,
                                text: ':warning: Session is still alive but no report was received from the AI agent ' +
                                      `after ${HOOK_MAX_RETRIES} attempts. Please check the tmux session manually.`,
                                thread_ts: threadTs,
                            });
                            if (warnResult?.ts) {
                                fs.writeFileSync(warningFile, warnResult.ts);
                            }
                            console.error(`Posted AI-agent-unresponsive warning after ${retryCount} retries (tmux alive)`);
                        } catch (err) {
                            console.error(`Failed to post warning: ${err.message}`);
                        }

                        if (assistantMessage) {
                            try {
                                await web.filesUploadV2({
                                    channel_id: channelId,
                                    thread_ts: threadTs,
                                    content: assistantMessage,
                                    filename: `alert-raw-output-${Date.now()}.txt`,
                                    title: 'Raw CLI Output (debug)',
                                    initial_comment: '_Raw output attached for debugging._',
                                });
                            } catch (err) {
                                console.error(`Failed to upload raw debug output: ${err.message}`);
                                traceLog('upload_error', {
                                    upload: 'raw-debug-output-warning',
                                    error: err.message,
                                    slack_error: err.data?.error || null,
                                    content_bytes: Buffer.byteLength(assistantMessage || ''),
                                    channel_id: channelId,
                                    thread_ts: threadTs,
                                });
                            }
                        }

                        // Do NOT mark the queue complete — the session is still alive.
                        return;
                    }

                    // tmux is genuinely gone → definitive incomplete notice.
                    try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
                    try { fs.unlinkSync(warningFile); } catch { /* ignore */ }
                    try { fs.unlinkSync(firstStopFile); } catch { /* ignore */ }
                    console.error(`tmux session dead, no valid report (assistantMessage: ${(assistantMessage || '').length} chars) — posting final incomplete notice`);
                    await web.chat.postMessage({
                        channel: channelId,
                        text: ':warning: Investigation incomplete — tmux session ended before a report was produced.',
                        thread_ts: threadTs,
                    });

                    if (assistantMessage) {
                        try {
                            await web.filesUploadV2({
                                channel_id: channelId,
                                thread_ts: threadTs,
                                content: assistantMessage,
                                filename: `alert-raw-output-${Date.now()}.txt`,
                                title: 'Raw CLI Output (debug)',
                                initial_comment: '_Raw output attached for debugging._',
                            });
                        } catch (err) {
                            console.error(`Failed to upload raw debug output: ${err.message}`);
                            traceLog('upload_error', {
                                upload: 'raw-debug-output-final',
                                error: err.message,
                                slack_error: err.data?.error || null,
                                content_bytes: Buffer.byteLength(assistantMessage || ''),
                                channel_id: channelId,
                                thread_ts: threadTs,
                            });
                        }
                    }

                    markAlertQueueComplete(channelId, alertMessageTs);
                }
            } else {
                await sendResponse(web, channelId, threadTs, assistantMessage, stats, lastUserId);
                console.error(`Response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
                // Auto-upload files the CLI explicitly flagged with
                // `Attachment written: <path>`. Relative paths resolve against
                // the CLI's cwd from the hook payload — the directory the CLI
                // actually wrote into, unlike the bot's repo_path guess.
                // Alert sessions are excluded: their report upload is built
                // into the alert branch above, and alert follow-up turns are
                // scanned by the socket.js poller already.
                const { uploadResponseAttachments } = require('./src/utils/attachments');
                await uploadResponseAttachments({
                    web,
                    channelId,
                    threadTs,
                    response: assistantMessage,
                    baseDir: hookInput.cwd || currentDir,
                });
                // Drop a marker so the bot's _verifyTurnProgress can confirm
                // the turn really completed even when Claude's reply is short
                // enough to stay inside the bottom-10 TUI rows (which the
                // scrollback-growth heuristic can't see).
                try {
                    fs.writeFileSync(`/tmp/cli-hook-post-${slackSessionKey}`, String(Date.now()));
                } catch { /* best-effort marker; bot has fallback heuristic */ }
                updateLastBotTs(slackSessionKey);
            }
        } catch (error) {
            console.error('Failed to post response:', error.message);
        }
        return;
    }

    const emoji = notificationType === 'completed' ? ':white_check_mark:' : ':hourglass_flowing_sand:';
    const status = notificationType === 'completed' ? 'Completed' : 'Waiting for Input';
    const fallbackText = `${emoji} Task ${status} - ${projectName}`;

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} Task ${status}` }
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Project:*\n${projectName}` },
                { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` }
            ]
        }
    ];

    try {
        await web.chat.postMessage({
            channel: channelId,
            text: fallbackText,
            blocks,
            thread_ts: threadTs
        });
        console.error(`Slack notification sent (${notificationType}) to ${channelId}${threadTs ? ' thread=' + threadTs : ''}`);
    } catch (error) {
        console.error('Failed to send Slack notification:', error.message);
        process.exit(1);
    }
}

sendHookNotification();
