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
        return;
    }

    throw new Error(`postQuestion: unknown layout ${layout}`);
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
            logger.error(`action handler failed: ${err.message}`);
        }
    });

    // Modal submission handler.
    slackApp.view(/^ask_user:/, async ({ ack, body, view, client }) => {
        try {
            const ackPayload = await handleViewSubmission({ body, view, client });
            await ack(ackPayload || {});
        } catch (err) {
            logger.error(`view handler failed: ${err.message}`);
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

    if (kind === '__bootstrap__') {
        // Open the single_modal for this question.
        const entry = findPendingEntry(requestId);
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

    if (kind === '__wizard__') {
        // TODO Phase 3: open step 1 of the wizard.
        logger.warn(`wizard: step machinery is stubbed (Phase 3)`);
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

async function handleViewSubmission({ body, view }) {
    const meta = safeParseJson(view.private_metadata);
    if (!meta || !meta.requestId) return null;
    const { requestId } = meta;

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

    askUserTool.resolvePending(requestId, { answers, status: 'ok' });
    return null; // close the modal
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

function findPendingEntry(requestId) {
    // Cheap lookup via listPending — fine for low cardinality.
    return askUserTool.listPending().find((p) => p.requestId === requestId);
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

module.exports = {
    postQuestion,
    wireSlackInteractions,
    // Exposed for tests
    _parseActionId: parseActionId,
};
