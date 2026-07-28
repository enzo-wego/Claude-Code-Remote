const Database = require('better-sqlite3');

jest.mock('../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

const SlackSocketHandler = require('../../src/channels/slack/socket');
const Jobs = require('../../src/services/jobs');
const PrTasks = require('../../src/services/pr-tasks');

function makeHandler() {
    const db = new Database(':memory:');
    const handler = Object.create(SlackSocketHandler.prototype);
    handler.config = {
        ownerUserId: 'UOWNER',
        prBoardEnabled: true,
        githubToken: 'token',
    };
    handler.jobs = new Jobs(db);
    handler.prTasks = new PrTasks(db);
    handler.logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    handler.app = {
        client: {
            conversations: {
                open: jest.fn().mockResolvedValue({
                    channel: { id: 'DOWNER' },
                }),
            },
            chat: {
                postMessage: jest.fn().mockResolvedValue({}),
            },
        },
    };
    handler._publishHome = jest.fn().mockResolvedValue();
    return handler;
}

describe('PR board socket wiring', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('detects a Slack PR URL when the authenticated user is requested', async () => {
        const handler = makeHandler();
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ login: 'enzo' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    title: 'Fix tax rounding',
                    user: { login: 'alice' },
                    head: { sha: 'abc123' },
                    requested_reviewers: [{ login: 'enzo' }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    check_runs: [{
                        status: 'completed',
                        conclusion: 'success',
                    }],
                }),
            });

        await handler._detectPrsFromMessage({
            text: 'please review https://github.com/wego/payments/pull/412',
        });

        expect(handler.prTasks.listActive()).toEqual([
            expect.objectContaining({
                repo: 'wego/payments',
                number: 412,
                ci: 'green',
                review_state: 'requested',
                origin: 'slack',
            }),
        ]);
        expect(handler._publishHome).toHaveBeenCalledWith('UOWNER');
    });

    test('apex completion marks the linked PR drafted and DMs PR actions', async () => {
        const handler = makeHandler();
        const task = handler.prTasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        const job = handler.jobs.enqueue('apex_review', {
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        handler.prTasks.setDraftJob(task.id, job.id);
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            summary: '1 blocking',
            body_md: '## Blocking\n- Fix this',
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.prTasks.get(task.id).status).toBe('drafted');
        const message = handler.app.client.chat.postMessage.mock.calls[0][0];
        const actionIds = message.blocks
            .find(block => block.type === 'actions')
            .elements
            .map(element => element.action_id);
        expect(actionIds).toEqual(['pr_post', 'pr_edit', 'pr_discard']);
        expect(handler._publishHome).toHaveBeenCalledWith('UOWNER');
    });
});
