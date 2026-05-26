/**
 * Slack-side I/O for the ask_user MCP tool.
 *
 * Two halves:
 *   1. `postQuestion()` — called by the tool handler. Picks an in-thread
 *      vs modal render and calls Slack Web API; records the slackTs /
 *      viewId on the pending registry entry so we can find it back later.
 *   2. `wireSlackInteractions(app)` — called once at bot start by Phase 2.
 *      Registers handlers for the `block_actions` and `view_submission`
 *      payloads our blocks produce; resolves pending entries.
 *
 * Phase 1 caveat: the wizard layout's `views.update` step machinery is
 * stubbed — it logs a TODO and falls through to single_modal. Phase 3 PR
 * fleshes it out with branching + Back/Next.
 */

const Logger = require('../core/logger');
const {
    ACTION_PREFIX,
    buildInThreadBlocks,
    buildModalView,
    buildWizardStepView,
    _maybeTruncateBody,
} = require('./slack-blocks');
// Namespace-import to dodge the ask-user-tool ↔ poster circular require —
// destructuring at module load time would capture undefined for these.
const askUserTool = require('./ask-user-tool');

const logger = new Logger('AskUserPoster');

// ─── Outbound — post the question ─────────────────────────────────────────

/**
 * @param {object} args
 * @param {object} args.slackApp   — @slack/bolt App
 * @param {string} args.requestId
 * @param {object} args.entry      — pending registry entry (mutated to record slackTs/viewId)
 */
async function postQuestion({ slackApp, requestId, entry }) {
    const { layout, questions, channel, threadTs } = entry;

    if (layout === 'single') {
        const { text, blocks } = buildInThreadBlocks(requestId, questions[0]);
        const result = await slackApp.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text,
            blocks,
        });
        entry.slackTs = result.ts;
        await maybeAttachLongPreviewBodies({ slackApp, questions, channel, threadTs });
        return;
    }

    if (layout === 'single_modal') {
        // We can't open a modal without a `trigger_id`, and we don't have
        // one (the tool call is initiated server-side, not in response to a
        // user action). Workaround: post a "Click to open" message in the
        // thread; the button's block_actions payload gives us a trigger_id.
        const result = await slackApp.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: 'You have questions to answer.',
            blocks: [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*The agent has questions for you.*' },
                },
                {
                    type: 'actions',
                    block_id: `${ACTION_PREFIX}:${requestId}:__bootstrap__`,
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: 'Answer now' },
                            value: 'open',
                            style: 'primary',
                            action_id: `${ACTION_PREFIX}:${requestId}:__bootstrap__:open`,
                        },
                    ],
                },
            ],
        });
        entry.slackTs = result.ts;
        await maybeAttachLongPreviewBodies({ slackApp, questions, channel, threadTs });
        return;
    }

    if (layout === 'wizard') {
        // Same trigger_id constraint — bootstrap with a "Start" button.
        // TODO Phase 3: full step machinery with views.update + branching.
        logger.warn(`wizard layout posted as bootstrap-only (Phase 3 stub) for ${requestId}`);
        const result = await slackApp.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: 'The agent has a multi-step question.',
            blocks: [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*Multi-step questions await.*' },
                },
                {
                    type: 'actions',
                    block_id: `${ACTION_PREFIX}:${requestId}:__wizard__`,
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: 'Start' },
                            value: 'start',
                            style: 'primary',
                            action_id: `${ACTION_PREFIX}:${requestId}:__wizard__:start`,
                        },
                    ],
                },
            ],
        });
        entry.slackTs = result.ts;
        await maybeAttachLongPreviewBodies({ slackApp, questions, channel, threadTs });
        return;
    }

    throw new Error(`postQuestion: unknown layout ${layout}`);
}

/**
 * For every `preview` question whose body would be truncated in the
 * Slack-side render (mrkdwn sections cap around 3000 chars), upload the
 * FULL body as a thread file so the user has the complete content to
 * review before answering. Best-effort: failures log but don't break the
 * surrounding flow (the user can still answer based on the truncated view).
 */
async function maybeAttachLongPreviewBodies({ slackApp, questions, channel, threadTs }) {
    if (!Array.isArray(questions)) return;
    for (const q of questions) {
        if (!q || q.type !== 'preview') continue;
        const body = q.body || '';
        const tr = _maybeTruncateBody(body, q.truncate_after_lines);
        if (!tr.didTruncate) continue;
        try {
            const lang = (q.language || '').replace(/[^A-Za-z0-9._-]/g, '') || 'txt';
            const filename = `preview-${q.id || 'q'}-${Date.now()}.${lang}`;
            await slackApp.client.files.uploadV2({
                channel_id: channel,
                thread_ts: threadTs,
                filename,
                content: body,
                initial_comment: `_Full body for "${(q.question || '').slice(0, 80)}" — the in-modal preview is truncated._`,
            });
        } catch (err) {
            logger.warn(`preview attach failed for question ${q.id || '?'}: ${err.message}`);
        }
    }
}

// ─── Inbound — Slack interaction routing ──────────────────────────────────

/**
 * Wire Bolt handlers. Called once at start-up by Phase 2 (start-slack-socket.js
 * or socket.js _setupListeners).
 *
 * Match contract:
 *   action_id   = ask_user:<requestId>:<questionId>:btn:<value>
 *               | ask_user:<requestId>:__bootstrap__:open
 *               | ask_user:<requestId>:__wizard__:start
 *   callback_id = ask_user:<requestId>:submit       (single_modal)
 *               | ask_user:<requestId>:wizard       (wizard step)
 */
function wireSlackInteractions(slackApp) {
    // Catch-all action handler (regex matches anything we own).
    slackApp.action(/^ask_user:/, async ({ ack, body, action, client }) => {
        await ack();
        try {
            await handleAction({ body, action, client });
        } catch (err) {
            logger.error(`action handler failed: ${err.message} stack=${err.stack}`);
        }
    });

    // Modal submission handler.
    slackApp.view(/^ask_user:/, async ({ ack, body, view, client }) => {
        try {
            const ackPayload = await handleViewSubmission({ body, view, client });
            await ack(ackPayload || {});
        } catch (err) {
            logger.error(`view handler failed: ${err.message} stack=${err.stack}`);
            await ack({ response_action: 'errors', errors: {} });
        }
    });

    // In-thread reply handler (for text questions and allow_custom selects).
    // Phase 2 wiring TODO: socket.js already has an app.event('message') —
    // we need to inject a pre-check that diverts to resolveTextReply()
    // when the thread has a pending text question. Documented here, not
    // installed automatically to avoid stomping on the existing handler.
    logger.info('wireSlackInteractions: action + view handlers wired (text-reply hook is TODO)');
}

async function handleAction({ body, action, client }) {
    const parsed = parseActionId(action.action_id);
    if (!parsed) return;
    const { requestId, questionId, kind, value } = parsed;

    // For sentinel rows (`ask_user:<reqId>:__bootstrap__:open`,
    // `ask_user:<reqId>:__wizard__:start`) the sentinel lands in the
    // `questionId` slot of parseActionId, NOT in `kind` — `kind` ends up
    // as the button's own label ('open' / 'start'). Earlier code checked
    // `kind === '__bootstrap__'`, which never matched, so clicks fell
    // through silently. Match on `questionId` instead.
    if (questionId === '__bootstrap__') {
        // Open the single_modal for this question.
        const entry = askUserTool.getPending(requestId);
        if (!entry) {
            logger.warn(`bootstrap: pending entry for ${requestId} missing`);
            return;
        }
        const view = buildModalView(requestId, entry.questions, {
            title: entry.title,
            submitLabel: entry.submitLabel,
        });
        await client.views.open({ trigger_id: body.trigger_id, view });
        return;
    }

    if (questionId === '__wizard__') {
        // Open the first visible step (skip leading questions whose show_if
        // can never fire — they'd block the wizard before the user can
        // answer anything).
        const entry = askUserTool.getPending(requestId);
        if (!entry) {
            logger.warn(`wizard: pending entry for ${requestId} missing`);
            return;
        }
        const firstStep = findNextVisibleStep(entry.questions, 0, entry.answers);
        if (firstStep >= entry.questions.length) {
            // No question is visible (all guarded by show_if that's false).
            // Resolve immediately with whatever answers exist (likely empty).
            askUserTool.resolvePending(requestId, {
                answers: entry.answers,
                status: 'ok',
            });
            return;
        }
        askUserTool.advancePendingStep(requestId, firstStep);
        const view = buildWizardStepView(
            requestId,
            entry.questions[firstStep],
            {
                title: entry.title,
                step: firstStep,
                totalSteps: entry.questions.length,
                isLast: firstStep === entry.questions.length - 1,
                hasPrev: false,
            },
        );
        await client.views.open({ trigger_id: body.trigger_id, view });
        return;
    }

    // Sentinel buttons open a modal instead of resolving the tool — they
    // appear on the non-compact select render ("Open picker") and the text
    // render ("Open editor"). Without this branch the generic `btn` handler
    // below would resolve the MCP call with the literal sentinel string
    // ("__open_modal__"), which Claude correctly treats as garbage and
    // retries — see Phase 3 E2E bug report.
    if (kind === 'btn' && (value === '__open_modal__' || value === '__open_text_modal__')) {
        const entry = askUserTool.getPending(requestId);
        if (!entry) {
            logger.warn(`open-modal: pending entry for ${requestId} missing`);
            return;
        }
        const view = buildModalView(requestId, entry.questions, {
            title: entry.title || 'Question',
            submitLabel: entry.submitLabel || 'Submit',
        });
        await client.views.open({ trigger_id: body.trigger_id, view });
        return;
    }

    if (kind === 'btn') {
        // In-thread button tap → resolve immediately for single-question.
        askUserTool.resolvePending(requestId, {
            answers: { [questionId]: value },
            status: 'ok',
        });
        // Clear buttons so the user knows the answer was received.
        try {
            await client.chat.update({
                channel: body.channel.id,
                ts: body.message.ts,
                text: body.message.text,
                blocks: [
                    ...body.message.blocks.filter((b) => b.type !== 'actions'),
                    {
                        type: 'context',
                        elements: [{ type: 'mrkdwn', text: `_You answered: *${value}*_` }],
                    },
                ],
            });
        } catch (err) {
            logger.warn(`failed to clear buttons after answer: ${err.message}`);
        }
    }
}

async function handleViewSubmission({ body, view, client }) {
    const meta = safeParseJson(view.private_metadata);
    if (!meta || !meta.requestId) return null;
    const { requestId } = meta;

    const callbackId = view.callback_id || '';
    if (callbackId.endsWith(':wizard')) {
        return handleWizardStep({ requestId, currentStep: meta.step ?? 0, view, client });
    }

    // Capture the in-thread bootstrap/CTA message coordinates BEFORE we
    // resolve, because resolvePending deletes the entry. After resolve we
    // edit that message to show the answer landed — otherwise the modal
    // closes silently and the user only sees "Open editor" / "Answer now"
    // sitting in the thread, looking unanswered.
    const entryBefore = askUserTool.getPending(requestId);
    const slackTs = entryBefore?.slackTs;
    const channel = entryBefore?.channel;

    const answers = extractAnswersFromView(view);
    askUserTool.resolvePending(requestId, { answers, status: 'ok' });

    if (client && channel && slackTs) {
        await updateBootstrapWithAnswers(client, channel, slackTs, answers).catch((err) =>
            logger.warn(`failed to update bootstrap after modal submit: ${err.message}`),
        );
    }
    return null; // close the modal
}

/**
 * Wizard step submit. Merges the current step's answer into accumulated
 * state, then either:
 *   - resolves the MCP call (last visible step) and closes the modal, OR
 *   - returns response_action=update with the next step's view so Slack
 *     swaps the modal contents in place.
 */
function handleWizardStep({ requestId, currentStep, view, client }) {
    const entry = askUserTool.getPending(requestId);
    if (!entry) return null;

    // Merge the answers on this view into the entry.
    const stepAnswers = extractAnswersFromView(view);
    askUserTool.setPendingAnswers(requestId, stepAnswers);
    const updated = askUserTool.getPending(requestId);

    const nextStep = findNextVisibleStep(
        entry.questions,
        currentStep + 1,
        updated.answers,
    );

    if (nextStep >= entry.questions.length) {
        // Done — capture the bootstrap message coords from `updated` BEFORE
        // resolve (resolvePending deletes the entry), then update the
        // "Multi-step questions await" CTA to show the final answers.
        const slackTs = updated.slackTs;
        const channel = updated.channel;
        askUserTool.resolvePending(requestId, {
            answers: updated.answers,
            status: 'ok',
        });
        if (client && channel && slackTs) {
            updateBootstrapWithAnswers(client, channel, slackTs, updated.answers).catch((err) =>
                logger.warn(`failed to update wizard bootstrap: ${err.message}`),
            );
        }
        return null;
    }

    askUserTool.advancePendingStep(requestId, nextStep);
    return {
        response_action: 'update',
        view: buildWizardStepView(
            requestId,
            entry.questions[nextStep],
            {
                title: entry.title,
                step: nextStep,
                totalSteps: entry.questions.length,
                isLast: nextStep === entry.questions.length - 1,
                hasPrev: true,
            },
        ),
    };
}

/**
 * Walk forward from `from` over the question list and return the first index
 * whose show_if evaluates true (or that has no show_if). Returns
 * questions.length when none qualifies — caller treats that as "done".
 */
function findNextVisibleStep(questions, from, answers) {
    for (let i = from; i < questions.length; i++) {
        if (shouldShowQuestion(questions[i], answers)) return i;
    }
    return questions.length;
}

/** Evaluate one question's show_if against accumulated answers. */
function shouldShowQuestion(question, answers) {
    const cond = question.show_if;
    if (!cond) return true;
    const ans = answers ? answers[cond.question_id] : undefined;
    if (ans == null) return false;
    if (cond.equals !== undefined && ans !== cond.equals) return false;
    if (Array.isArray(cond.in) && !cond.in.includes(ans)) return false;
    return true;
}

/** Extract { questionId → value } from a view's state.values, for either layout. */
function extractAnswersFromView(view) {
    const state = view.state?.values || {};
    const answers = {};
    for (const [blockId, blockValues] of Object.entries(state)) {
        // blockId shape: ask_user:<reqId>:<questionId>
        const parts = blockId.split(':');
        if (parts[0] !== ACTION_PREFIX || parts.length < 3) continue;
        const questionId = parts[2];
        for (const v of Object.values(blockValues)) {
            answers[questionId] = extractAnswerValue(v);
        }
    }
    return answers;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseActionId(actionId) {
    // ask_user:<requestId>:<questionId>:btn:<value>
    // ask_user:<requestId>:__bootstrap__:open
    // ask_user:<requestId>:__wizard__:start
    const parts = actionId.split(':');
    if (parts[0] !== ACTION_PREFIX) return null;
    const [, requestId, questionId, kind, ...rest] = parts;
    return { requestId, questionId, kind, value: rest.join(':') };
}

// Legacy lookup kept for any external callers; new code uses
// askUserTool.getPending directly so it gets the full entry shape.
function findPendingEntry(requestId) {
    const entry = askUserTool.getPending(requestId);
    if (!entry) return null;
    return {
        requestId,
        sessionId: entry.sessionId,
        channel: entry.channel,
        threadTs: entry.threadTs,
        layout: entry.layout,
        step: entry.step,
        questions: entry.questions,
        title: entry.title,
        submitLabel: entry.submitLabel,
    };
}

function extractAnswerValue(v) {
    if (v.selected_option) return v.selected_option.value;
    if (v.selected_options) return v.selected_options.map((o) => o.value);
    if (typeof v.value === 'string') return v.value;
    return null;
}

function safeParseJson(s) {
    try { return JSON.parse(s); } catch { return null; }
}

/**
 * After a modal flow resolves, edit the original bootstrap / in-thread CTA
 * message to (a) drop the now-stale "Answer now" / "Open editor" / "Start"
 * button and (b) show the user a short summary of what they answered.
 * Matches the look the in-thread button path produces in handleAction.
 */
async function updateBootstrapWithAnswers(client, channel, ts, answers) {
    const summary = formatAnswersSummary(answers);
    return client.chat.update({
        channel,
        ts,
        text: 'Question answered',
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '*Question answered.*' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: `_${summary}_` }] },
        ],
    });
}

function formatAnswersSummary(answers) {
    if (!answers || Object.keys(answers).length === 0) return 'You answered: (no values)';
    return 'You answered: ' + Object.entries(answers)
        .map(([k, v]) => {
            const val = Array.isArray(v) ? v.join(', ') : (v == null ? '(none)' : String(v));
            const trimmed = val.length > 200 ? `${val.slice(0, 200)}…` : val;
            return `*${k}*=${trimmed}`;
        })
        .join(', ');
}

module.exports = {
    postQuestion,
    wireSlackInteractions,
    // Exposed for tests
    _parseActionId: parseActionId,
    _findNextVisibleStep: findNextVisibleStep,
    _shouldShowQuestion: shouldShowQuestion,
    _handleViewSubmission: handleViewSubmission,
    _handleAction: handleAction,
};
