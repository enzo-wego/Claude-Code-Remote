/**
 * Regression — the "Open picker" / "Open editor" sentinel buttons must
 * open a Slack modal, NOT resolve the MCP call with the literal sentinel
 * string. Phase 3 E2E surfaced Claude getting `__open_modal__` back as the
 * answer and looping forever.
 */

const askUserTool = require('../../src/mcp/ask-user-tool');
const { _handleAction } = require('../../src/mcp/poster');
const { ACTION_PREFIX } = require('../../src/mcp/slack-blocks');

describe('handleAction — sentinel-button → views.open (regression)', () => {
    let requestId;
    let entry;
    let client;

    beforeEach(() => {
        requestId = 'req-open-modal';
        entry = {
            resolve: jest.fn(),
            reject: jest.fn(),
            sessionId: 'sess',
            channel: 'C',
            threadTs: 'T',
            layout: 'single',
            questions: [{
                id: 'scope',
                type: 'select',
                question: 'Scope of work?',
                options: [
                    { label: 'Plans only', value: 'plans', description: 'No code.' },
                    { label: 'Plans + skeleton', value: 'skel', description: 'Branch + stubs.' },
                ],
            }],
            answers: {},
            step: 0,
            title: 'Scope',
            submitLabel: 'Submit',
            timeout: setTimeout(() => {}, 60000),
        };
        askUserTool._injectPendingForTests(requestId, entry);

        client = {
            views: { open: jest.fn(async () => ({ ok: true })) },
            chat: { update: jest.fn(async () => ({ ok: true })) },
        };
    });

    afterEach(() => {
        clearTimeout(entry.timeout);
        askUserTool.cancelPending(requestId, 'cancelled');
    });

    test('__open_modal__ opens a Slack modal and does NOT resolve the tool', async () => {
        const body = { trigger_id: 'trigger-123' };
        const action = {
            action_id: `${ACTION_PREFIX}:${requestId}:scope:btn:__open_modal__`,
        };

        await _handleAction({ body, action, client });

        // Modal opened
        expect(client.views.open).toHaveBeenCalledTimes(1);
        const arg = client.views.open.mock.calls[0][0];
        expect(arg.trigger_id).toBe('trigger-123');
        expect(arg.view.type).toBe('modal');
        expect(arg.view.callback_id).toBe(`${ACTION_PREFIX}:${requestId}:submit`);

        // Pending entry NOT resolved — bug had it resolving with '__open_modal__'
        expect(entry.resolve).not.toHaveBeenCalled();
        expect(askUserTool.getPending(requestId)).not.toBeNull();
        // No chat.update either — sentinel doesn't blow away the buttons.
        expect(client.chat.update).not.toHaveBeenCalled();
    });

    test('__open_text_modal__ opens a Slack modal and does NOT resolve the tool', async () => {
        const body = { trigger_id: 'trigger-456' };
        const action = {
            action_id: `${ACTION_PREFIX}:${requestId}:scope:btn:__open_text_modal__`,
        };
        await _handleAction({ body, action, client });

        expect(client.views.open).toHaveBeenCalledTimes(1);
        expect(entry.resolve).not.toHaveBeenCalled();
    });

    test('regular btn click still resolves the tool with the option value', async () => {
        const body = {
            trigger_id: 'trigger-x',
            channel: { id: 'C' },
            message: { ts: '1.2', text: 'q', blocks: [] },
        };
        const action = {
            action_id: `${ACTION_PREFIX}:${requestId}:scope:btn:plans`,
        };
        await _handleAction({ body, action, client });

        expect(entry.resolve).toHaveBeenCalledTimes(1);
        expect(entry.resolve.mock.calls[0][0]).toEqual({
            answers: { scope: 'plans' },
            status: 'ok',
        });
        expect(client.views.open).not.toHaveBeenCalled();
    });
});
