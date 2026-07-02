jest.mock('../../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

jest.mock('child_process', () => ({
    exec: jest.fn(),
    execSync: jest.fn(),
    execFileSync: jest.fn(),
}));

const SlackSocketHandler = require('../../../src/channels/slack/socket');
const { execSync } = require('child_process');

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
            _parseCodexModelOptions: SlackSocketHandler.prototype._parseCodexModelOptions,
            _extractSessionStats: SlackSocketHandler.prototype._extractSessionStats,
            _handleModelCommand: SlackSocketHandler.prototype._handleModelCommand,
            _handleCodexModelCommand: SlackSocketHandler.prototype._handleCodexModelCommand,
            _handleCliLocalCommand: SlackSocketHandler.prototype._handleCliLocalCommand,
            _processCommand: SlackSocketHandler.prototype._processCommand,
        };
        return { h, session };
    }

    beforeEach(() => {
        execSync.mockClear();
    });

    test('codex /model is scraped as a local panel instead of being blocked', async () => {
        const { h } = harness({
            cliType: 'codex',
            output: [
                '› /model',
                '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
                'Select model',
                '1. gpt-5.5 current Frontier model for complex coding, research, and real-',
                'world work.',
                '2. gpt-5.4 Strong model for everyday coding.',
                '3. gpt-5.4-mini Small, fast, and cost-efficient model for simpler',
                'coding tasks.',
                'Esc to close',
            ].join('\n'),
        });

        await h._processCommand('CTEST', '123.456', '/model', null, '123.456');

        expect(h._injectCommand).not.toHaveBeenCalled();
        expect(h._injectLocalCommand).toHaveBeenCalledWith('slack-TEST-123', '/model', 4000);
        expect(h.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'CTEST',
            thread_ts: '123.456',
            text: expect.stringContaining('Reply with `/model <number>`'),
        }));
        expect(execSync).toHaveBeenCalledWith('tmux send-keys -t slack-TEST-123 Escape');
        expect(h._updateLastBotTs).toHaveBeenCalledWith('CTEST-123.456', '999.000');
    });

    test('codex /model number selects a visible picker option', async () => {
        const { h } = harness({
            cliType: 'codex',
            output: [
                '› /model',
                '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
                'Select model',
                '1. gpt-5.5 current Frontier model for complex coding, research, and real-',
                'world work.',
                '2. gpt-5.4 Strong model for everyday coding.',
                '3. gpt-5.4-mini Small, fast, and cost-efficient model for simpler',
                'coding tasks.',
                'Esc to close',
                'model: gpt-5.4 high',
            ].join('\n'),
        });

        await h._processCommand('CTEST', '123.456', '/model 2', null, '123.456');

        expect(h._injectCommand).not.toHaveBeenCalled();
        expect(h._injectLocalCommand).toHaveBeenCalledWith('slack-TEST-123', '/model', 4000);
        expect(execSync).toHaveBeenCalledWith('tmux send-keys -t slack-TEST-123 Down');
        expect(execSync).toHaveBeenCalledWith('tmux send-keys -t slack-TEST-123 Enter');
        expect(h.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('Selected Codex model option 2'),
        }));
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
