/**
 * Regression — single-modal ask_user must ack promptly (2026-08-10).
 *
 * Bug: the view handler awaited updateBootstrapWithAnswers (a chat.update)
 * before returning. On a 429/5xx the Slack WebClient's retry backoff can
 * blow past Slack's 3s view_submission ack budget, so the modal renders
 * "We had some trouble connecting" even though resolvePending already
 * recorded the answer. Fix: fire-and-forget the update, matching the wizard
 * final-step path.
 */

const askUserTool = require('../../src/mcp/ask-user-tool');
const poster = require('../../src/mcp/poster');
const { ACTION_PREFIX } = require('../../src/mcp/slack-blocks');

const { _handleViewSubmission } = poster;

describe('handleViewSubmission — single-modal ack timing', () => {
    let requestId;
    let entry;

    beforeEach(() => {
        requestId = 'req-single';
        entry = {
            resolve: jest.fn(),
            reject: jest.fn(),
            sessionId: 'sess',
            channel: 'C123',
            slackTs: 'T456',
            threadTs: 'T000',
            layout: 'single',
            questions: [
                { id: 'next', type: 'select', question: 'Next?' },
                { id: 'wording', type: 'text', question: 'Wording?' },
            ],
            answers: {},
            step: 0,
            title: 'Q',
            submitLabel: 'Submit',
            timeout: setTimeout(() => {}, 60000),
        };
        askUserTool._injectPendingForTests(requestId, entry);
    });

    afterEach(() => {
        clearTimeout(entry.timeout);
        askUserTool.cancelPending(requestId, 'cancelled');
        jest.restoreAllMocks();
    });

    test('resolves without awaiting a never-settling chat.update, recording the answer first', async () => {
        const resolveSpy = jest.spyOn(askUserTool, 'resolvePending');
        const client = {
            chat: { update: jest.fn(() => new Promise(() => {})) }, // never settles
        };
        const view = mockSingleModalView({
            requestId,
            answers: { next: 'verify_only', wording: 'friendly' },
        });

        // Real-timer race: the handler must win against a 1s wall clock even
        // though chat.update never settles. If the await had survived, the
        // handler branch would lose the race (or hit jest's test timeout).
        const winner = await Promise.race([
            _handleViewSubmission({ body: {}, view, client }).then((r) => ({ who: 'handler', r })),
            new Promise((res) => setTimeout(() => res({ who: 'timeout' }), 1000)),
        ]);

        expect(winner.who).toBe('handler');
        expect(winner.r).toBeNull(); // null → ack closes the modal

        // resolvePending fired exactly once, BEFORE the (still-pending) update.
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        expect(client.chat.update).toHaveBeenCalledTimes(1);
        expect(resolveSpy.mock.invocationCallOrder[0])
            .toBeLessThan(client.chat.update.mock.invocationCallOrder[0]);

        // The answer really landed: the MCP resolver ran with the answers and
        // the pending entry is gone.
        expect(entry.resolve).toHaveBeenCalledTimes(1);
        expect(entry.resolve.mock.calls[0][0]).toEqual({
            answers: { next: 'verify_only', wording: 'friendly' },
            status: 'ok',
        });
        expect(askUserTool.getPending(requestId)).toBeNull();
    });

    test('still calls chat.update with the same channel/ts + a summary of the answers', async () => {
        const client = { chat: { update: jest.fn().mockResolvedValue({ ok: true }) } };
        const body = { user: { id: 'U9' } };
        const view = mockSingleModalView({
            requestId,
            answers: { next: 'verify_only', wording: 'friendly' },
        });

        const result = await _handleViewSubmission({ body, view, client });
        expect(result).toBeNull();

        expect(client.chat.update).toHaveBeenCalledTimes(1);
        const arg = client.chat.update.mock.calls[0][0];
        expect(arg.channel).toBe('C123');
        expect(arg.ts).toBe('T456');
        const rendered = JSON.stringify(arg.blocks);
        expect(rendered).toContain('verify_only');
        expect(rendered).toContain('friendly');
    });
});

describe('handleViewSubmission — wizard path stays intact', () => {
    let requestId;
    let entry;

    beforeEach(() => {
        requestId = 'req-wiz-intact';
        entry = {
            resolve: jest.fn(),
            reject: jest.fn(),
            sessionId: 'sess',
            channel: 'C',
            threadTs: 'T',
            slackTs: 'T',
            layout: 'wizard',
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x', value: 'x' }] },
                { id: 'b', type: 'text', question: 'B?' },
            ],
            answers: {},
            step: 0,
            title: 'Wizard',
            submitLabel: 'Submit',
            timeout: setTimeout(() => {}, 60000),
        };
        askUserTool._injectPendingForTests(requestId, entry);
    });

    afterEach(() => {
        clearTimeout(entry.timeout);
        askUserTool.cancelPending(requestId, 'cancelled');
    });

    test('a wizard submit with a remaining visible step still returns response_action=update', async () => {
        const view = {
            callback_id: `${ACTION_PREFIX}:${requestId}:wizard`,
            private_metadata: JSON.stringify({ requestId, step: 0 }),
            state: {
                values: {
                    [`${ACTION_PREFIX}:${requestId}:a`]: {
                        [`${ACTION_PREFIX}:${requestId}:a:any`]: {
                            selected_option: { value: 'x', text: { type: 'plain_text', text: 'x' } },
                        },
                    },
                },
            },
        };
        const result = await _handleViewSubmission({ body: {}, view });

        expect(result).toBeTruthy();
        expect(result.response_action).toBe('update');
        expect(result.view.callback_id).toBe(`${ACTION_PREFIX}:${requestId}:wizard`);
        // Not resolved yet — still mid-wizard.
        expect(entry.resolve).not.toHaveBeenCalled();
    });
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** Build a fake single-modal (callback_id ...:submit) view_submission view. */
function mockSingleModalView({ requestId, answers }) {
    const values = {};
    for (const [qid, val] of Object.entries(answers)) {
        const blockId = `${ACTION_PREFIX}:${requestId}:${qid}`;
        values[blockId] = {
            [`${blockId}:any`]: { value: val },
        };
    }
    return {
        callback_id: `${ACTION_PREFIX}:${requestId}:submit`,
        private_metadata: JSON.stringify({ requestId }),
        state: { values },
    };
}
