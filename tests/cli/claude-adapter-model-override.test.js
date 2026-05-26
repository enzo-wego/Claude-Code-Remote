/**
 * Claude adapter — SLACK_CLAUDE_MODEL launch-flag composition.
 *
 * The env var appends `--model <X>` to the launch command so the bot's
 * spawned Claude sessions can be pinned to a less aggressive model
 * without touching the user's interactive Claude config. Used as a
 * workaround for Opus-with-xhigh-effort flakiness at invoking MCP tools
 * (see PR #14 / Phase 3 E2E notes).
 */

const path = require('path');

function load(envOverrides = {}) {
    const saved = {};
    for (const [k, v] of Object.entries(envOverrides)) {
        saved[k] = process.env[k];
        if (v == null) delete process.env[k];
        else process.env[k] = v;
    }
    delete require.cache[require.resolve('../../src/cli/claude-adapter')];
    const adapter = require('../../src/cli/claude-adapter');
    return { adapter, restore: () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v == null) delete process.env[k];
            else process.env[k] = v;
        }
    } };
}

describe('claude-adapter SLACK_CLAUDE_MODEL', () => {
    test('omitted → launch command unchanged', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude --dangerously-skip-permissions',
            SLACK_CLAUDE_MODEL: null,
        });
        try {
            expect(adapter.buildLaunchCommand()).toBe('claude --dangerously-skip-permissions');
        } finally { restore(); }
    });

    test('valid model → appended as --model flag', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude --dangerously-skip-permissions',
            SLACK_CLAUDE_MODEL: 'claude-sonnet-4-6',
        });
        try {
            expect(adapter.buildLaunchCommand())
                .toBe('claude --dangerously-skip-permissions --model claude-sonnet-4-6');
        } finally { restore(); }
    });

    test('alphanumeric+dot+dash+underscore are all allowed', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude',
            SLACK_CLAUDE_MODEL: 'opus-4-7.1m_ctx',
        });
        try {
            expect(adapter.buildLaunchCommand()).toBe('claude --model opus-4-7.1m_ctx');
        } finally { restore(); }
    });

    test('shell metacharacters → silently dropped (no injection)', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude',
            SLACK_CLAUDE_MODEL: 'sonnet; rm -rf /',
        });
        try {
            expect(adapter.buildLaunchCommand()).toBe('claude');
        } finally { restore(); }
    });

    test('empty string → ignored', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude',
            SLACK_CLAUDE_MODEL: '',
        });
        try {
            expect(adapter.buildLaunchCommand()).toBe('claude');
        } finally { restore(); }
    });

    test('buildResumeCommand picks up the model too (uses buildLaunchCommand internally)', () => {
        const { adapter, restore } = load({
            SLACK_CLAUDE_COMMAND: 'claude --dangerously-skip-permissions',
            SLACK_CLAUDE_MODEL: 'sonnet-4-6',
        });
        try {
            const uuid = '12345678-1234-1234-1234-123456789012';
            const cmd = adapter.buildResumeCommand(uuid);
            expect(cmd).toContain('--model sonnet-4-6');
            expect(cmd).toContain('--resume 12345678-1234-1234-1234-123456789012');
        } finally { restore(); }
    });
});
