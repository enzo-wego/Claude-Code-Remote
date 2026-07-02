jest.mock('../../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

const SlackSocketHandler = require('../../../src/channels/slack/socket');

describe('SlackSocketHandler missed mention replay', () => {
    function harness({ handled = [] } = {}) {
        const h = {
            config: { channelId: 'CMAIN' },
            _botUserId: 'UBOT',
            _handledMentionTs: new Set(handled),
            alertMonitor: { monitoredChannelIds: [] },
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            _getSession: jest.fn(() => null),
            _handleMention: jest.fn(async () => {}),
            app: {
                client: {
                    auth: { test: jest.fn(async () => ({ user_id: 'UBOT' })) },
                    conversations: {
                        history: jest.fn(async () => ({
                            messages: [
                                {
                                    ts: '1782962196.423419',
                                    text: '<@UBOT> start codex',
                                    user: 'UUSER',
                                },
                            ],
                        })),
                        replies: jest.fn(async () => ({
                            messages: [
                                {
                                    ts: '1782962196.423419',
                                    text: '<@UBOT> start codex',
                                    user: 'UUSER',
                                },
                            ],
                        })),
                    },
                    chat: { postMessage: jest.fn(async () => ({})) },
                },
            },
            _replayMissedMentions: SlackSocketHandler.prototype._replayMissedMentions,
        };
        return h;
    }

    test('skips a mention already handled by the live event path', async () => {
        const h = harness({ handled: ['1782962196.423419'] });

        await h._replayMissedMentions();

        expect(h._handleMention).not.toHaveBeenCalled();
        expect(h.logger.info).toHaveBeenCalledWith('[startup] replayMissedMentions: 0 replayed');
    });

    test('marks a replayed mention before handling it', async () => {
        const h = harness();

        await h._replayMissedMentions();

        expect(h._handleMention).toHaveBeenCalledTimes(1);
        expect(h._handledMentionTs.has('1782962196.423419')).toBe(true);
    });
});
