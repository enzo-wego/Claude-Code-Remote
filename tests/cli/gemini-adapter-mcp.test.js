/**
 * Gemini adapter — installMcp / uninstallMcp.
 *
 * Verifies the global `~/.gemini/settings.json` update using Strategy A
 * (HTTP with environment variable templating):
 *   - writes the `slack-ask` entry with ${CLAUDE_REMOTE_MCP_URL_FULL}
 *   - returns launchEnv with the expanded URL and sessionKey
 *   - does NOT clobber existing mcpServers
 *   - uninstallMcp returns false (global config stays in place)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock os.homedir() so we don't touch the user's real ~/.gemini/settings.json
const TMP_HOME = path.join(os.tmpdir(), `gemini-mcp-test-${Date.now()}`);
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

// We must require the adapter AFTER mocking os.homedir because it defines
// SETTINGS_PATH at the module level.
const adapter = require('../../src/cli/gemini-adapter');

const GEMINI_DIR = path.join(TMP_HOME, '.gemini');
const SETTINGS_PATH = path.join(GEMINI_DIR, 'settings.json');

describe('gemini-adapter installMcp', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
        fs.mkdirSync(GEMINI_DIR, { recursive: true });
    });

    afterAll(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
    });

    test('writes the global config and returns launchEnv with URL templating', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });

        expect(result.configPath).toBe(SETTINGS_PATH);
        expect(result.launchFlag).toBe(''); // Gemini doesn't need a flag for global config
        expect(result.launchEnv).toEqual({
            CLAUDE_REMOTE_SESSION_ID: 'test-session',
            CLAUDE_REMOTE_MCP_URL_FULL: 'http://127.0.0.1:9998/mcp/test-session',
        });

        const written = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        expect(written.mcpServers['slack-ask']).toEqual({
            url: '${CLAUDE_REMOTE_MCP_URL_FULL}',
        });
    });

    test('idempotently updates without clobbering existing servers', () => {
        const existing = {
            mcpServers: {
                'other-server': { command: 'other', args: [] }
            }
        };
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(existing, null, 2));

        adapter.installMcp({
            sessionKey: 'session-1',
            mcpServerUrl: 'http://localhost/mcp',
        });

        const written = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        expect(written.mcpServers['other-server']).toBeDefined();
        expect(written.mcpServers['slack-ask']).toEqual({
            url: '${CLAUDE_REMOTE_MCP_URL_FULL}',
        });
    });

    test('trailing slashes on mcpServerUrl are stripped in launchEnv', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp//',
        });
        expect(result.launchEnv.CLAUDE_REMOTE_MCP_URL_FULL)
            .toBe('http://127.0.0.1:9998/mcp/test-session');
    });

    test('missing args produce a no-op with empty env', () => {
        expect(adapter.installMcp()).toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
        expect(adapter.installMcp({ sessionKey: 'x' }))
            .toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
        expect(adapter.installMcp({ mcpServerUrl: 'http://x' }))
            .toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
    });

    test('uninstallMcp returns false and leaves config (global shared file)', () => {
        adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });
        expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
        expect(adapter.uninstallMcp()).toBe(false);
        expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
    });

    test('uninstallMcpGlobal removes the slack-ask key and preserves the rest', () => {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
            mcpServers: {
                'slack-ask': { url: '${X}' },
                'other-server': { command: 'other', args: [] }
            }
        }, null, 2));
        const result = adapter.uninstallMcpGlobal();
        expect(result.changed).toBe(true);
        const after = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        expect(after.mcpServers['slack-ask']).toBeUndefined();
        expect(after.mcpServers['other-server']).toBeDefined();
    });

    test('uninstallMcpGlobal is a no-op when no entry exists', () => {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
            mcpServers: { 'other': { command: 'other' } }
        }, null, 2));
        const result = adapter.uninstallMcpGlobal();
        expect(result.changed).toBe(false);
    });

    test('askUserToolName returns mcp__slack-ask__ask_user', () => {
        expect(adapter.askUserToolName()).toBe('mcp__slack-ask__ask_user');
        expect(adapter.askUserGuidance()).toContain('mcp__slack-ask__ask_user');
    });
});
