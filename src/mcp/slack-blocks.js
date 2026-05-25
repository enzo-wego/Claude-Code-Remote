/**
 * Block Kit renderers for the four question primitives.
 *
 * Pure functions only — no Slack API calls, no I/O. Caller (poster.js)
 * decides whether to post these blocks in a thread or open them as a modal.
 *
 * The action_id convention is `ask_user:<requestId>:<questionId>:<optionValue>`
 * so the interaction handler can dispatch with one regex.
 */

const ACTION_PREFIX = 'ask_user';

// ─── Public renderers ─────────────────────────────────────────────────────

/**
 * Build blocks for the single-question, in-thread render path.
 * Returns `{ text, blocks }` ready to pass to chat.postMessage.
 *
 * @param {string} requestId
 * @param {object} question — normalized question
 */
function buildInThreadBlocks(requestId, question) {
    switch (question.type) {
        case 'select':   return selectInThread(requestId, question);
        case 'confirm':  return confirmInThread(requestId, question);
        case 'preview':  return previewInThread(requestId, question);
        case 'text':     return textInThread(requestId, question);
        default:
            throw new Error(`unsupported question type: ${question.type}`);
    }
}

/**
 * Build a Slack modal view for the multi-question (`single_modal`) layout.
 * Returns the `view` object suitable for views.open.
 *
 * @param {string} requestId
 * @param {object[]} questions
 * @param {object} opts — { title, submitLabel }
 */
function buildModalView(requestId, questions, opts = {}) {
    const blocks = [];
    for (const q of questions) {
        blocks.push(...modalBlockForQuestion(requestId, q));
    }
    return {
        type: 'modal',
        callback_id: `${ACTION_PREFIX}:${requestId}:submit`,
        private_metadata: JSON.stringify({ requestId }),
        title: { type: 'plain_text', text: truncatePlain(opts.title || 'Question', 24) },
        submit: { type: 'plain_text', text: opts.submitLabel || 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks,
    };
}

/**
 * Build a wizard-step modal view (one step out of N).
 *
 * @param {string} requestId
 * @param {object} question — the single question for this step
 * @param {object} opts — { title, step, totalSteps, isLast, hasPrev }
 */
function buildWizardStepView(requestId, question, opts = {}) {
    const blocks = modalBlockForQuestion(requestId, question);
    blocks.unshift({
        type: 'context',
        elements: [
            {
                type: 'mrkdwn',
                text: `Step ${opts.step + 1} of ${opts.totalSteps}`,
            },
        ],
    });
    return {
        type: 'modal',
        callback_id: `${ACTION_PREFIX}:${requestId}:wizard`,
        private_metadata: JSON.stringify({ requestId, step: opts.step }),
        title: { type: 'plain_text', text: truncatePlain(opts.title || 'Question', 24) },
        submit: { type: 'plain_text', text: opts.isLast ? 'Submit' : 'Next' },
        close: { type: 'plain_text', text: opts.hasPrev ? 'Back' : 'Cancel' },
        blocks,
    };
}

// ─── In-thread renderers ──────────────────────────────────────────────────

function selectInThread(requestId, q) {
    // ≤4 options + single-select + no descriptions → render as button row.
    // Otherwise fall back to a section-of-options + "Pick one in modal" CTA.
    const compact = !q.multi
        && q.options.length <= 4
        && !q.options.some((o) => o.description);
    if (compact) {
        return {
            text: q.question,
            blocks: [
                section(`*${q.question}*`),
                {
                    type: 'actions',
                    block_id: `${ACTION_PREFIX}:${requestId}:${q.id}:row`,
                    elements: q.options.map((opt) =>
                        actionButton(
                            requestId, q.id, opt.value, opt.label, /* style */ undefined,
                        ),
                    ).concat(q.allow_custom ? [
                        actionButton(requestId, q.id, '__custom__', 'Custom…', 'default'),
                    ] : []),
                },
            ],
        };
    }
    // Open-a-modal CTA for richer renders.
    return {
        text: q.question,
        blocks: [
            section(`*${q.question}*`),
            ...q.options.map((opt) =>
                section(`*${opt.label}*${opt.description ? `\n${opt.description}` : ''}`),
            ),
            {
                type: 'actions',
                block_id: `${ACTION_PREFIX}:${requestId}:${q.id}:open`,
                elements: [
                    actionButton(requestId, q.id, '__open_modal__', 'Open picker', 'primary'),
                ],
            },
        ],
    };
}

function confirmInThread(requestId, q) {
    return {
        text: q.question,
        blocks: [
            section(`*${q.question}*`),
            {
                type: 'actions',
                block_id: `${ACTION_PREFIX}:${requestId}:${q.id}:row`,
                elements: q.buttons.map((btn) =>
                    actionButton(
                        requestId, q.id, btn.value ?? btn.label, btn.label, btn.style,
                    ),
                ),
            },
        ],
    };
}

function previewInThread(requestId, q) {
    const body = q.body || '';
    const truncated = maybeTruncateBody(body, q.truncate_after_lines);
    const codeBlock = q.language
        ? `\`\`\`${q.language}\n${truncated.body}\n\`\`\``
        : `\`\`\`\n${truncated.body}\n\`\`\``;
    return {
        text: q.question || 'Preview',
        blocks: [
            section(`*${q.question || 'Preview'}*`),
            section(codeBlock),
            ...(truncated.didTruncate ? [
                {
                    type: 'context',
                    elements: [{
                        type: 'mrkdwn',
                        text: `_Truncated. Full body attached separately (TODO Phase 3)._`,
                    }],
                },
            ] : []),
            {
                type: 'actions',
                block_id: `${ACTION_PREFIX}:${requestId}:${q.id}:row`,
                elements: (q.buttons || [
                    { label: 'Approve', value: 'approve', style: 'primary' },
                    { label: 'Reject',  value: 'reject',  style: 'danger' },
                ]).map((btn) =>
                    actionButton(requestId, q.id, btn.value ?? btn.label, btn.label, btn.style),
                ),
            },
        ],
    };
}

function textInThread(requestId, q) {
    // For text questions we either prompt for a thread reply or open a modal.
    // The "Open editor" button covers multiline / placeholder UX.
    return {
        text: q.question,
        blocks: [
            section(`*${q.question}*\n_Reply in this thread, or click below for a multi-line editor._`),
            {
                type: 'actions',
                block_id: `${ACTION_PREFIX}:${requestId}:${q.id}:row`,
                elements: [
                    actionButton(requestId, q.id, '__open_text_modal__', 'Open editor', 'primary'),
                ],
            },
        ],
    };
}

// ─── Modal block builders (per-question, used by single_modal + wizard) ───

function modalBlockForQuestion(requestId, q) {
    const blockId = `${ACTION_PREFIX}:${requestId}:${q.id}`;
    switch (q.type) {
        case 'select': {
            const element = q.multi
                ? {
                    type: 'checkboxes',
                    action_id: `${blockId}:select`,
                    options: q.options.map(optToBlockOption),
                }
                : {
                    type: 'radio_buttons',
                    action_id: `${blockId}:select`,
                    options: q.options.map(optToBlockOption),
                };
            return [{
                type: 'input',
                block_id: blockId,
                label: { type: 'plain_text', text: truncatePlain(q.question, 150) },
                element,
                ...(q.allow_custom ? {} : {}),
            }];
        }
        case 'text':
            return [{
                type: 'input',
                block_id: blockId,
                label: { type: 'plain_text', text: truncatePlain(q.question, 150) },
                element: {
                    type: 'plain_text_input',
                    action_id: `${blockId}:text`,
                    multiline: !!q.multiline,
                    initial_value: q.default,
                    placeholder: q.placeholder
                        ? { type: 'plain_text', text: q.placeholder }
                        : undefined,
                },
            }];
        case 'confirm':
            // In a modal context, confirm becomes a radio button (modals
            // can't carry the in-thread button-row UX).
            return [{
                type: 'input',
                block_id: blockId,
                label: { type: 'plain_text', text: truncatePlain(q.question, 150) },
                element: {
                    type: 'radio_buttons',
                    action_id: `${blockId}:confirm`,
                    options: q.buttons.map((b) => ({
                        text: { type: 'plain_text', text: b.label },
                        value: b.value ?? b.label,
                    })),
                },
            }];
        case 'preview': {
            const truncated = maybeTruncateBody(q.body || '', q.truncate_after_lines);
            return [
                section(`*${q.question || 'Preview'}*`),
                section(
                    q.language
                        ? `\`\`\`${q.language}\n${truncated.body}\n\`\`\``
                        : `\`\`\`\n${truncated.body}\n\`\`\``,
                ),
                {
                    type: 'input',
                    block_id: blockId,
                    label: { type: 'plain_text', text: 'Decision' },
                    element: {
                        type: 'radio_buttons',
                        action_id: `${blockId}:preview`,
                        options: (q.buttons || [
                            { label: 'Approve', value: 'approve' },
                            { label: 'Reject',  value: 'reject' },
                        ]).map((b) => ({
                            text: { type: 'plain_text', text: b.label },
                            value: b.value ?? b.label,
                        })),
                    },
                },
            ];
        }
        default:
            throw new Error(`unsupported question type for modal: ${q.type}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function section(mrkdwn) {
    return { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } };
}

function actionButton(requestId, questionId, optionValue, label, style) {
    const btn = {
        type: 'button',
        text: { type: 'plain_text', text: truncatePlain(label, 75) },
        value: truncatePlain(optionValue, 2000),
        action_id: `${ACTION_PREFIX}:${requestId}:${questionId}:btn:${optionValue}`,
    };
    if (style && style !== 'default') btn.style = style;
    return btn;
}

function optToBlockOption(opt) {
    const out = {
        text: { type: 'plain_text', text: truncatePlain(opt.label, 75) },
        value: truncatePlain(opt.value, 75),
    };
    if (opt.description) {
        out.description = { type: 'plain_text', text: truncatePlain(opt.description, 75) };
    }
    return out;
}

function truncatePlain(s, max) {
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function maybeTruncateBody(body, maxLines) {
    if (!maxLines) {
        // Fallback hard cap at 2800 chars so we stay under the 3000 mrkdwn limit.
        if (body.length > 2800) {
            return { body: `${body.slice(0, 2800)}\n…`, didTruncate: true };
        }
        return { body, didTruncate: false };
    }
    const lines = body.split('\n');
    if (lines.length <= maxLines) return { body, didTruncate: false };
    return { body: `${lines.slice(0, maxLines).join('\n')}\n…`, didTruncate: true };
}

module.exports = {
    ACTION_PREFIX,
    buildInThreadBlocks,
    buildModalView,
    buildWizardStepView,
    // Exposed for tests
    _modalBlockForQuestion: modalBlockForQuestion,
    _maybeTruncateBody: maybeTruncateBody,
};
