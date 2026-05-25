/**
 * tmux-helper buildTmuxCommand — covers the new extraEnv param.
 */

const { buildTmuxCommand } = require('../../src/utils/tmux-helper');

describe('buildTmuxCommand', () => {
    test('exports SLACK_SESSION_KEY and CLI_SOURCE when provided', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'sess-123', 'claude');
        expect(cmd).toContain("export SLACK_SESSION_KEY='sess-123'");
        expect(cmd).toContain("export CLI_SOURCE='claude'");
    });

    test('appends additional env from extraEnv', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'k', 'claude', {
            CLAUDE_REMOTE_MCP_URL: 'http://127.0.0.1:9998/mcp',
            CLAUDE_REMOTE_SESSION_ID: 'sess-abc',
        });
        expect(cmd).toContain("export CLAUDE_REMOTE_MCP_URL='http://127.0.0.1:9998/mcp'");
        expect(cmd).toContain("export CLAUDE_REMOTE_SESSION_ID='sess-abc'");
    });

    test('sanitizes env key names — only [A-Za-z0-9_] survive', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'k', 'claude', {
            'BAD; rm -rf /': 'value',
            'GOOD_KEY': 'ok',
        });
        // The dangerous key gets sanitized to "BADrm-rf" → wait actually
        // anything not in [A-Za-z0-9_] is stripped, so "BAD; rm -rf /"
        // becomes "BADrmrf". Either way, no `;` or `/` or space survives
        // into the export line.
        expect(cmd).not.toContain('BAD;');
        expect(cmd).not.toContain('rm -rf');
        expect(cmd).toContain("export GOOD_KEY='ok'");
    });

    test('escapes single quotes in env values', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'k', 'claude', {
            URL: "http://h/path?q=it's",
        });
        // Single-quote inside the value becomes '\'' (close, escaped-quote, reopen)
        expect(cmd).toContain("export URL='http://h/path?q=it'\\''s'");
    });

    test('skips null/undefined values', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'k', 'claude', {
            SET: 'yes',
            NULLED: null,
            UNDEFINED: undefined,
        });
        expect(cmd).toContain("export SET='yes'");
        expect(cmd).not.toContain("export NULLED");
        expect(cmd).not.toContain("export UNDEFINED");
    });

    test('extraEnv omitted entirely — no regression', () => {
        const cmd = buildTmuxCommand('S', '/tmp', 'claude', 'k', 'claude');
        expect(cmd).toContain("export SLACK_SESSION_KEY='k'");
        expect(cmd).toContain("export CLI_SOURCE='claude'");
    });
});
