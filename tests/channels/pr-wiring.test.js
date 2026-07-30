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
                postMessage: jest.fn().mockResolvedValue({
                    ts: '1712345678.000100',
                }),
                getPermalink: jest.fn().mockResolvedValue({
                    permalink: 'https://slack.example/archives/DOWNER/p1712345678000100',
                }),
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
            // /user/teams — needed so team review requests are not missed.
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ([
                    { slug: 'payments-geeks', organization: { login: 'wego' } },
                ]),
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

    test('detects a PR routed to my team, with nobody named individually', async () => {
        const handler = makeHandler();
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ login: 'enzo' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ([
                    { slug: 'payments-geeks', organization: { login: 'wego' } },
                ]),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    title: 'Team-routed change',
                    user: { login: 'alice' },
                    head: { sha: 'abc123' },
                    requested_reviewers: [],
                    requested_teams: [{ slug: 'payments-geeks' }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    check_runs: [{ status: 'completed', conclusion: 'success' }],
                }),
            });

        await handler._detectPrsFromMessage({
            text: 'eyes please https://github.com/wego/payments/pull/999',
        });

        expect(handler.prTasks.listActive()).toEqual([
            expect.objectContaining({
                number: 999,
                review_state: 'requested',
                lane: 'review',
            }),
        ]);
    });

    test('first PR message creates an anchor, threads the reply, and persists both links', async () => {
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

        const stored = handler.prTasks.get(task.id);
        expect(stored).toMatchObject({
            status: 'drafted',
            slack_ts: '1712345678.000100',
            slack_permalink: 'https://slack.example/archives/DOWNER/p1712345678000100',
        });
        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
        const [anchor, message] = handler.app.client.chat.postMessage.mock.calls
            .map(call => call[0]);
        expect(anchor).toEqual({
            channel: 'DOWNER',
            text: '*<https://github.com/wego/payments/pull/412|wego/payments#412>* — wego/payments#412',
            unfurl_links: false,
            unfurl_media: false,
        });
        expect(handler.app.client.chat.getPermalink).toHaveBeenCalledWith({
            channel: 'DOWNER',
            message_ts: '1712345678.000100',
        });
        expect(message.thread_ts).toBe('1712345678.000100');
        const actionIds = message.blocks
            .find(block => block.type === 'actions')
            .elements
            .map(element => element.action_id);
        expect(actionIds).toEqual(['pr_post', 'pr_edit', 'pr_discard']);
        expect(handler._publishHome).toHaveBeenCalledWith('UOWNER');
    });

    test('a second message about the same PR reuses the thread without another anchor', async () => {
        const handler = makeHandler();
        const task = handler.prTasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        handler.prTasks.setSlackThread(
            task.id,
            '1712345678.000100',
            'https://slack.example/archives/DOWNER/p1712345678000100'
        );
        const job = handler.jobs.enqueue('pane_message', {
            repo: 'wego/payments',
            pr: 412,
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            tail: 'Review posted',
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        expect(handler.app.client.chat.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                thread_ts: '1712345678.000100',
                text: expect.stringContaining('Reviewer finished'),
            })
        );
        expect(handler.app.client.chat.getPermalink).not.toHaveBeenCalled();
    });

    test('address-comments completion posts its pane result in the PR thread', async () => {
        const handler = makeHandler();
        const task = handler.prTasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        handler.prTasks.setSlackThread(
            task.id,
            '1712345678.000100',
            'https://slack.example/archives/DOWNER/p1712345678000100'
        );
        const job = handler.jobs.enqueue('address_comments', {
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            title: 'Fix tax rounding',
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            pane_id: 'pane-enzobot-412',
            tail: 'Addressed three review threads',
            reply_written: true,
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        const message = handler.app.client.chat.postMessage.mock.calls[0][0];
        expect(message).toEqual(expect.objectContaining({
            thread_ts: '1712345678.000100',
        }));
        expect(message.text).toContain('wego/payments#412');
        expect(message.text).toContain('pane-enzobot-412');
        expect(message.text).toContain('Addressed three review threads');
        expect(message.text).toContain(':white_check_mark: Finished');
        expect(message).not.toHaveProperty('blocks');
        expect(handler.app.client.chat.getPermalink).not.toHaveBeenCalled();
        expect(handler._publishHome).toHaveBeenCalledWith('UOWNER');
    });

    test('address-comments without a reply draft warns in the PR thread', async () => {
        const handler = makeHandler();
        const task = handler.prTasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        handler.prTasks.setSlackThread(
            task.id,
            '1712345678.000100',
            'https://slack.example/archives/DOWNER/p1712345678000100'
        );
        const job = handler.jobs.enqueue('address_comments', {
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            title: 'Fix tax rounding',
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            pane_id: 'pane-enzobot-412',
            tail: 'Say the word and I will draft the replies',
            reply_written: false,
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        const message = handler.app.client.chat.postMessage.mock.calls[0][0];
        expect(message).toEqual(expect.objectContaining({
            thread_ts: '1712345678.000100',
        }));
        expect(message.text).toContain(':warning:');
        expect(message.text).toContain('stopped without writing its reply draft');
        expect(message.text).toContain('pane is still live');
        expect(message.text).toContain('may be waiting on the owner');
        expect(message.text).toContain('pane-enzobot-412');
        expect(message.text).not.toContain(':white_check_mark:');
    });

    test('a failed permalink lookup still persists the ts and delivers in-thread', async () => {
        const handler = makeHandler();
        const task = handler.prTasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'https://github.com/wego/payments/pull/412',
        });
        handler.app.client.chat.getPermalink.mockRejectedValueOnce(
            new Error('permalink unavailable')
        );
        const job = handler.jobs.enqueue('pane_close', {
            repo: 'wego/payments',
            pr: 412,
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {});

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.prTasks.get(task.id)).toMatchObject({
            slack_ts: '1712345678.000100',
            slack_permalink: null,
        });
        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
        expect(handler.app.client.chat.postMessage.mock.calls[1][0])
            .toEqual(expect.objectContaining({
                thread_ts: '1712345678.000100',
                text: ':door: Review session closed. Nothing was posted.',
            }));
        expect(handler.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('permalink unavailable')
        );
    });

    test('a job with no matching PR row is still delivered flat', async () => {
        const handler = makeHandler();
        const job = handler.jobs.enqueue('pane_message', {
            repo: 'wego/payments',
            pr: 999,
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            tail: 'Review posted',
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        const message = handler.app.client.chat.postMessage.mock.calls[0][0];
        expect(message.text).toContain('wego/payments#999');
        expect(message).not.toHaveProperty('thread_ts');
        expect(handler.app.client.chat.getPermalink).not.toHaveBeenCalled();
    });

    test('address-comments completion without a PR row is delivered flat', async () => {
        const handler = makeHandler();
        const job = handler.jobs.enqueue('address_comments', {
            repo: 'wego/payments',
            pr: 999,
            url: 'https://github.com/wego/payments/pull/999',
            title: 'Unknown PR row',
        });
        const leased = handler.jobs.lease('mac');
        handler.jobs.complete(leased.id, leased.lease_id, {
            tail: 'Addressed the remaining review thread',
            reply_written: true,
        });

        await handler._onJobResult(handler.jobs.get(job.id));

        expect(handler.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        const message = handler.app.client.chat.postMessage.mock.calls[0][0];
        expect(message.text).toContain('wego/payments#999');
        expect(message.text).toContain('Addressed the remaining review thread');
        expect(message.text).not.toContain('undefined');
        expect(message.text).not.toContain('in pane');
        expect(message).not.toHaveProperty('thread_ts');
        expect(message).not.toHaveProperty('blocks');
        expect(handler.app.client.chat.getPermalink).not.toHaveBeenCalled();
        expect(handler._publishHome).toHaveBeenCalledWith('UOWNER');
    });
});
