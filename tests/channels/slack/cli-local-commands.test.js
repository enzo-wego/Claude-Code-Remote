jest.mock('../../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

const SlackSocketHandler = require('../../../src/channels/slack/socket');

describe('SlackSocketHandler adapter local slash commands', () => {
    function harness({ cliType = 'codex', output = '' } = {}) {
        const session = {
            sessionName: 'slack-TEST-123',
            channelId: 'CTEST',
            threadTs: '123.456',
            repoPath: '/repo',
            createdAt: Date.now(),
            cliType,
        };
        const h = {
            app: { client: { chat: { postMessage: jest.fn(async () => ({ ts: '999.000' })) } } },
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            _getSession: jest.fn(() => session),
            _isTmuxSessionAlive: jest.fn(() => true),
            _touchSession: jest.fn(),
            _updateLastBotTs: jest.fn(),
            _clearSessionTimeout: jest.fn(),
            _injectCommand: jest.fn(async () => ''),
            _injectLocalCommand: jest.fn(async () => output),
            _captureOutput: jest.fn(() => output),
            _scrapeLocalCommandResult: SlackSocketHandler.prototype._scrapeLocalCommandResult,
            _handleModelCommand: SlackSocketHandler.prototype._handleModelCommand,
            _handleCliLocalCommand: SlackSocketHandler.prototype._handleCliLocalCommand,
            _processCommand: SlackSocketHandler.prototype._processCommand,
        };
        return { h, session };
    }

    test('codex /model is answered bot-side instead of generic injection', async () => {
        const { h } = harness({ cliType: 'codex' });

        await h._processCommand('CTEST', '123.456', '/model', null, '123.456');

        expect(h._injectCommand).not.toHaveBeenCalled();
        expect(h.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'CTEST',
            thread_ts: '123.456',
            text: expect.stringContaining("Mid-session model switch isn't supported for `codex`"),
        }));
        expect(h._updateLastBotTs).toHaveBeenCalledWith('CTEST-123.456', '999.000');
    });

    test('codex safe local commands are injected once and their pane output is posted', async () => {
        const { h } = harness({
            cliType: 'codex',
            output: [
                '› /status',
                'model: gpt-5.4',
                'mcp servers: slackask',
                '›',
            ].join('\n'),
        });

        await h._processCommand('CTEST', '123.456', '/status', null, '123.456');

        expect(h._injectCommand).not.toHaveBeenCalled();
        expect(h._injectLocalCommand).toHaveBeenCalledWith('slack-TEST-123', '/status', 4000);
        expect(h.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'CTEST',
            thread_ts: '123.456',
            text: expect.stringContaining('model: gpt-5.4'),
        }));
    });
});
