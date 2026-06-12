jest.mock('../../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

const SlackSocketHandler = require('../../../src/channels/slack/socket');

// The idle timer kills tmux on `last_bot_ts` staleness. A turn that is still
// mid-flight has posted nothing — routine after a KillMode=process service
// restart, where the tmux session survives but no poller is watching it.
// These tests pin the guard that checks the pane's working indicators before
// killing (incident 2026-06-12).
describe('SlackSocketHandler session timeout working-pane guard', () => {
    function harness({ paneWorking, lastBotTs = null }) {
        const h = {
            config: { sessionInactivityTimeoutMs: 900000 },
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            sessionTimers: new Map(),
            pollers: new Map(),
            killedSessions: [],
            _getSession: jest.fn(() => ({
                sessionName: 'slack-TEST-123',
                sessionKey: 'CTEST-123',
                channelId: 'CTEST',
                threadTs: '123.456',
                cliType: 'claude',
                lastBotTs,
            })),
            _parseBotTsMs: SlackSocketHandler.prototype._parseBotTsMs,
            _isPaneWorking: jest.fn(() => paneWorking),
            _setThreadStatus: jest.fn(),
            _addReaction: jest.fn(async () => {}),
            _removeReaction: jest.fn(async () => {}),
            _completeQueueItem: jest.fn(),
            app: { client: { chat: { postMessage: jest.fn(async () => ({})) } } },
            _startSessionTimeout: SlackSocketHandler.prototype._startSessionTimeout,
        };
        return h;
    }

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('reschedules instead of killing when the pane is still working', async () => {
        const h = harness({ paneWorking: true });
        h._startSessionTimeout('CTEST-123');

        await jest.advanceTimersByTimeAsync(900000);

        expect(h._isPaneWorking).toHaveBeenCalledWith('slack-TEST-123', 'claude');
        // No kill side effects fired
        expect(h._setThreadStatus).not.toHaveBeenCalled();
        expect(h.app.client.chat.postMessage).not.toHaveBeenCalled();
        // A recheck timer was re-armed
        expect(h.sessionTimers.has('CTEST-123')).toBe(true);
    });

    test('recheck is capped at 5 minutes, not a full inactivity window', async () => {
        const h = harness({ paneWorking: true });
        h._startSessionTimeout('CTEST-123');

        await jest.advanceTimersByTimeAsync(900000);
        expect(h._isPaneWorking).toHaveBeenCalledTimes(1);

        // 5 minutes later the guard re-evaluates (not 15)
        await jest.advanceTimersByTimeAsync(300000);
        expect(h._isPaneWorking).toHaveBeenCalledTimes(2);
    });

    test('idle pane still times out and notifies the thread', async () => {
        const h = harness({ paneWorking: false });
        h._startSessionTimeout('CTEST-123');

        await jest.advanceTimersByTimeAsync(900000);

        expect(h._isPaneWorking).toHaveBeenCalledTimes(1);
        // Timeout path ran: shimmer cleared, no-bot-reply fallback notice posted
        expect(h._setThreadStatus).toHaveBeenCalledWith('CTEST', '123.456', '');
        expect(h.app.client.chat.postMessage).toHaveBeenCalledTimes(1);
        expect(h.sessionTimers.has('CTEST-123')).toBe(false);
    });

    test('delayOverrideMs takes precedence over the last_bot_ts anchor', async () => {
        const nowSec = Date.now() / 1000;
        const h = harness({ paneWorking: true, lastBotTs: String(nowSec) });
        h._startSessionTimeout('CTEST-123', 1000);

        // Fires after the 1s override even though the last_bot_ts anchor would
        // push the delay ~15min out. (The callback then takes the fresh-bot
        // reschedule branch — entry into the callback is the assertion here.)
        await jest.advanceTimersByTimeAsync(1000);
        expect(h._getSession).toHaveBeenCalledTimes(3); // arm + fire + re-arm
    });
});
