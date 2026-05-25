/**
 * Regression — Phase 3 E2E surfaced that the "Answer now" and "Start"
 * sentinel buttons in single_modal / wizard bootstrap messages were
 * being parsed but never matched any handler branch (the conditional
 * was looking at `kind` but the sentinel lives in `questionId`). Clicks
 * acked silently, no modal opened, no error logged.
 */

const askUserTool = require('../../src/mcp/ask-user-tool');
const { _handleAction } = require('../../src/mcp/poster');
const { ACTION_PREFIX } = require('../../src/mcp/slack-blocks');

describe('handleAction — bootstrap + wizard sentinels (regression)', () => {
    let requestId;
    let entry;
    let client;

    beforeEach(() => {
        requestId = 'req-boot';
        entry = {
            resolve: jest.fn(),
            reject: jest.fn(),
            sessionId: 'sess',
            channel: 'C',
            threadTs: 'T',
            layout: 'single_modal',
            questions: [
                { id: 'pkg',  type: 'select', question: 'Pkg?',  options: [{ label: 'a', value: 'a' }] },
                { id: 'note', type: 'text', question: 'Note?' },
            ],
            answers: {},
            step: 0,
            title: 'Form',
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

    test('single_modal bootstrap "Answer now" click opens the multi-question modal', async () => {
        await _handleAction({
            body: { trigger_id: 'trig-1' },
            action: { action_id: `${ACTION_PREFIX}:${requestId}:__bootstrap__:open` },
            client,
        });

        expect(client.views.open).toHaveBeenCalledTimes(1);
        const arg = client.views.open.mock.calls[0][0];
        expect(arg.trigger_id).toBe('trig-1');
        expect(arg.view.callback_id).toBe(`${ACTION_PREFIX}:${requestId}:submit`);
        // Modal contains one input block per question.
        const inputBlocks = arg.view.blocks.filter((b) => b.type === 'input');
        expect(inputBlocks).toHaveLength(2);
        // Pending stays alive — modal hasn't been submitted yet.
        expect(entry.resolve).not.toHaveBeenCalled();
    });

    test('wizard "Start" click opens the first wizard step view', async () => {
        // Switch entry to wizard layout for this case.
        entry.layout = 'wizard';

        await _handleAction({
            body: { trigger_id: 'trig-2' },
            action: { action_id: `${ACTION_PREFIX}:${requestId}:__wizard__:start` },
            client,
        });

        expect(client.views.open).toHaveBeenCalledTimes(1);
        const arg = client.views.open.mock.calls[0][0];
        // Wizard callback_id is `:wizard`, not `:submit`.
        expect(arg.view.callback_id).toBe(`${ACTION_PREFIX}:${requestId}:wizard`);
        // First step pointer recorded on the entry.
        expect(askUserTool.getPending(requestId).step).toBe(0);
        expect(entry.resolve).not.toHaveBeenCalled();
    });

    test('bootstrap with missing pending entry logs a warning and bails (no throw)', async () => {
        askUserTool.cancelPending(requestId, 'cancelled');
        await expect(
            _handleAction({
                body: { trigger_id: 'trig-3' },
                action: { action_id: `${ACTION_PREFIX}:${requestId}:__bootstrap__:open` },
                client,
            }),
        ).resolves.toBeUndefined();
        expect(client.views.open).not.toHaveBeenCalled();
    });
});
