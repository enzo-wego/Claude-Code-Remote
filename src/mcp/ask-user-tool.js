/**
 * `ask_user` MCP tool — schema, handler, pending-question registry.
 *
 * The handler:
 *   1. Validates and normalizes the input to one or more question objects.
 *   2. Looks up the session's Slack channel/thread from SQLite.
 *   3. Posts the question via src/mcp/poster.js (Block Kit blocks built by
 *      src/mcp/slack-blocks.js).
 *   4. Stores a resolver in the pending-question registry, keyed by a UUID.
 *   5. Returns a Promise that the resolver will fulfill when the Slack
 *      interaction handler in src/mcp/poster.js calls `resolvePending()`.
 *
 * This file is import-safe before the rest of Phase 2 wiring lands: nothing
 * here auto-runs at require time.
 */

const { randomUUID } = require('crypto');
const Logger = require('../core/logger');
const { postQuestion } = require('./poster');

const logger = new Logger('AskUserTool');

// ─── Pending-question registry ────────────────────────────────────────────
//
// Map<requestId, {
//   resolve:   (answer) => void
//   reject:    (err)    => void
//   sessionId: string
//   channel:   string
//   threadTs:  string
//   slackTs?:  string       // for in-thread button messages
//   viewId?:   string       // for modal flows
//   layout:    "single" | "single_modal" | "wizard"
//   questions: NormalizedQuestion[]
//   answers:   Record<id, value>      // partial — for wizard steps
//   step:      number                  // current wizard step
//   timeout:   NodeJS.Timeout
// }>
//
const pending = new Map();

// ─── Tool schema (MCP `tools/list` payload) ───────────────────────────────

const askUserToolDefinition = {
    name: 'ask_user',
    description:
        'Ask the remote Slack user one or more questions. Use instead of the ' +
        'built-in AskUserQuestion / ask_user_question — those render in the ' +
        'TUI that the user is NOT looking at. This tool posts to Slack and ' +
        'blocks until the user responds. Always pass `questions[]`; a single ' +
        'question is just a one-element array.',
    inputSchema: {
        type: 'object',
        required: ['questions'],
        properties: {
            questions: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    required: ['type', 'question'],
                    properties: {
                        id: { type: 'string', description: 'Result key. Auto-generated if omitted.' },
                        type: { enum: ['select', 'confirm', 'text', 'preview'] },
                        question: { type: 'string' },

                        // select
                        options: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['label'],
                                properties: {
                                    label: { type: 'string' },
                                    description: { type: 'string' },
                                    value: { type: 'string' },
                                },
                            },
                        },
                        multi: { type: 'boolean' },
                        allow_custom: { type: 'boolean' },

                        // confirm
                        buttons: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['label'],
                                properties: {
                                    label: { type: 'string' },
                                    value: { type: 'string' },
                                    style: { enum: ['primary', 'danger', 'default'] },
                                },
                            },
                        },

                        // text
                        placeholder: { type: 'string' },
                        multiline: { type: 'boolean' },
                        default: { type: 'string' },

                        // preview
                        body: { type: 'string' },
                        language: { type: 'string' },
                        truncate_after_lines: { type: 'integer' },

                        // wizard branching
                        show_if: {
                            type: 'object',
                            properties: {
                                question_id: { type: 'string' },
                                equals: { type: 'string' },
                                in: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                },
            },

            title: { type: 'string' },
            submit_label: { type: 'string' },
            layout: { enum: ['auto', 'single', 'single_modal', 'wizard'] },
            timeout_ms: { type: 'integer' },
        },
    },
};

// ─── Input normalization ──────────────────────────────────────────────────

function normalizeInput(input) {
    if (!input || !Array.isArray(input.questions) || input.questions.length === 0) {
        throw new Error('ask_user: input.questions[] is required (≥1 element)');
    }
    return {
        layout: input.layout && input.layout !== 'auto'
            ? input.layout
            : pickAutoLayout(input.questions),
        questions: input.questions.map(normalizeQuestion),
        title: input.title,
        submitLabel: input.submit_label || 'Submit',
        timeoutMs: input.timeout_ms || defaultTimeoutMs(),
    };
}

function normalizeQuestion(q) {
    if (!q || !q.type) {
        throw new Error('ask_user: question.type is required');
    }
    const out = { ...q };
    if (!out.id) out.id = randomUUID();
    if (out.type === 'select' && (!out.options || out.options.length === 0)) {
        throw new Error(`ask_user: select question "${out.id}" needs options[]`);
    }
    if (out.type === 'confirm' && (!out.buttons || out.buttons.length === 0)) {
        // Default to yes/no when buttons omitted.
        out.buttons = [
            { label: 'Yes', value: 'yes', style: 'primary' },
            { label: 'No', value: 'no', style: 'danger' },
        ];
    }
    // Normalize option.value defaults to its label.
    if (out.options) {
        out.options = out.options.map((opt) => ({
            ...opt,
            value: opt.value ?? opt.label,
        }));
    }
    return out;
}

function pickAutoLayout(questions) {
    const hasBranching = questions.some((q) => q.show_if);
    const hasPreview = questions.some((q) => q.type === 'preview');
    if (hasBranching || hasPreview) return 'wizard';
    if (questions.length === 1) return 'single';
    return 'single_modal';
}

function defaultTimeoutMs() {
    return Number(process.env.MCP_DEFAULT_TIMEOUT_MS || 30 * 60 * 1000);
}

// ─── Tool handler (MCP `tools/call` invocation) ───────────────────────────

async function handleAskUser(input, ctx) {
    const { sessionId, db, slackApp } = ctx;
    const normalized = normalizeInput(input);

    // Look up Slack target from the session table — same path the regular
    // hook notifier already uses (see cli-hook-notify.js).
    const session = db
        .prepare('SELECT channel_id, thread_ts FROM sessions WHERE session_key = ?')
        .get(sessionId);
    if (!session) {
        throw new Error(`ask_user: no Slack session found for ${sessionId}`);
    }

    const requestId = randomUUID();

    // Build promise BEFORE posting so the resolver is in the registry
    // before any user could possibly reply.
    const answerPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(requestId);
            resolve({ status: 'timeout' });
        }, normalized.timeoutMs);

        pending.set(requestId, {
            resolve,
            reject,
            sessionId,
            channel: session.channel_id,
            threadTs: session.thread_ts,
            slackTs: null,
            viewId: null,
            layout: normalized.layout,
            questions: normalized.questions,
            title: normalized.title,
            submitLabel: normalized.submitLabel,
            answers: {},
            step: 0,
            timeout,
        });
    });

    // Hand the post off to the renderer/poster pair. The poster updates
    // the entry with slackTs / viewId so the interaction handler can find
    // it back from the Slack payload.
    try {
        await postQuestion({
            slackApp,
            requestId,
            entry: pending.get(requestId),
        });
    } catch (err) {
        pending.delete(requestId);
        throw new Error(`ask_user: failed to post to Slack: ${err.message}`);
    }

    logger.info(`ask_user: posted question ${requestId} for session ${sessionId}`);

    const result = await answerPromise;

    // Always return uniform `{answers, status}` keyed by question.id. The
    // single-question caller just reads `answers[questions[0].id]`.
    return {
        content: [{ type: 'text', text: JSON.stringify({
            answers: result.answers || {},
            status: result.status || 'ok',
        }) }],
    };
}

// ─── External entry points (called by Slack interaction handler) ──────────

/**
 * Resolve a pending question with the user's answer(s).
 *
 * Called from src/mcp/poster.js when a `block_actions` or `view_submission`
 * payload arrives whose action/callback id starts with `ask_user:<requestId>`.
 *
 * @param {string} requestId
 * @param {{ answers?: object, answer?: any, status?: string }} payload
 */
function resolvePending(requestId, payload) {
    const entry = pending.get(requestId);
    if (!entry) {
        logger.warn(`resolvePending: no pending entry for ${requestId}`);
        return false;
    }
    clearTimeout(entry.timeout);
    pending.delete(requestId);
    entry.resolve(payload);
    return true;
}

/** Cancel a pending question early (e.g. session closed). */
function cancelPending(requestId, reason = 'cancelled') {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    pending.delete(requestId);
    entry.resolve({ status: reason });
    return true;
}

/** Read-only stripped view for telemetry / debugging. */
function listPending() {
    return Array.from(pending.entries()).map(([id, e]) => ({
        requestId: id,
        sessionId: e.sessionId,
        channel: e.channel,
        threadTs: e.threadTs,
        layout: e.layout,
        step: e.step,
    }));
}

/**
 * Return the full pending entry for a requestId (or null). Used by the
 * Slack interaction handler when building modal views — it needs
 * questions[], title, accumulated answers, etc.
 */
function getPending(requestId) {
    return pending.get(requestId) || null;
}

/** Merge a partial answers map into a pending entry. Returns true if found. */
function setPendingAnswers(requestId, partial) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    entry.answers = { ...entry.answers, ...(partial || {}) };
    return true;
}

/** Advance the wizard step pointer. Returns true if the entry exists. */
function advancePendingStep(requestId, nextStep) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    entry.step = nextStep;
    return true;
}

// Mutate (don't replace) module.exports so poster.js's namespace import
// (`const askUserTool = require('./ask-user-tool')`) sees the populated
// shape. Node's circular-require resolves poster's reference to the
// original exports object created at the start of this module's load;
// replacing it via `module.exports = {...}` would orphan that reference
// and make every askUserTool.<name> call from poster undefined at
// runtime (caught by Phase 3 wizard tests).
Object.assign(module.exports, {
    askUserToolDefinition,
    handleAskUser,
    resolvePending,
    cancelPending,
    listPending,
    getPending,
    setPendingAnswers,
    advancePendingStep,
    // Exposed for tests
    _normalizeInput: normalizeInput,
    _injectPendingForTests: (requestId, entry) => pending.set(requestId, entry),
});
