jest.mock('../../../src/services/daily-summary', () => ({
    runDailySummary: jest.fn(),
    parseChannelsConfig: jest.fn(() => []),
}));

const SlackSocketHandler = require('../../../src/channels/slack/socket');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('SlackSocketHandler serialized CLI launches', () => {
    function harness() {
        return {
            _serializedCliLaunches: new Map(),
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            _runSerializedCliLaunch: SlackSocketHandler.prototype._runSerializedCliLaunch,
        };
    }

    test('runs launches for the same CLI one at a time', async () => {
        const h = harness();
        const first = deferred();
        const events = [];

        const firstRun = h._runSerializedCliLaunch('codex', 'session-a', async () => {
            events.push('start-a');
            await first.promise;
            events.push('finish-a');
            return 'a';
        });
        const secondRun = h._runSerializedCliLaunch('codex', 'session-b', async () => {
            events.push('start-b');
            return 'b';
        });

        await flushPromises();
        expect(events).toEqual(['start-a']);

        first.resolve();
        await expect(firstRun).resolves.toBe('a');
        await expect(secondRun).resolves.toBe('b');
        expect(events).toEqual(['start-a', 'finish-a', 'start-b']);
        expect(h._serializedCliLaunches.has('codex')).toBe(false);
    });

    test('does not serialize different CLI types', async () => {
        const h = harness();
        const first = deferred();
        const events = [];

        const codexRun = h._runSerializedCliLaunch('codex', 'session-a', async () => {
            events.push('start-codex');
            await first.promise;
            return 'codex';
        });
        const claudeRun = h._runSerializedCliLaunch('claude', 'session-b', async () => {
            events.push('start-claude');
            return 'claude';
        });

        await flushPromises();
        expect(events).toEqual(['start-codex', 'start-claude']);

        first.resolve();
        await expect(codexRun).resolves.toBe('codex');
        await expect(claudeRun).resolves.toBe('claude');
    });
});
