/**
 * Codex adapter — installMcp / uninstallMcp.
 *
 * Verifies the global ~/.codex/config.toml update for Codex's HTTP MCP
 * config:
 *   - writes a [mcp_servers.slackask] entry pointing at the session URL
 *   - returns no launch env because Codex owns the HTTP transport
 *   - preserves unrelated TOML and does not duplicate the global block
 *   - uninstallMcp is a no-op because the config entry is shared globally
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = path.join(os.tmpdir(), `codex-mcp-test-${Date.now()}`);
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const adapter = require('../../src/cli/codex-adapter');

const CODEX_DIR = path.join(TMP_HOME, '.codex');
const CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');

describe('codex-adapter installMcp', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
        fs.mkdirSync(CODEX_DIR, { recursive: true });
    });

    afterAll(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
    });

    test('writes the global HTTP config for the session', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });

        expect(result.configPath).toBe(CONFIG_PATH);
        expect(result.launchFlag).toBe('');
        expect(result.launchEnv).toEqual({});

        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(body).toContain('[mcp_servers.slackask]');
        expect(body).toContain('url = "http://127.0.0.1:9998/mcp/test-session"');
        expect(body).not.toContain('mcp-stdio-proxy.js');
    });

    test('preserves existing TOML while adding the MCP block once', () => {
        fs.writeFileSync(CONFIG_PATH, [
            '[features]',
            'codex_hooks = true',
            '',
            '[mcp_servers.slack-ask]',
            'command = "/old/node"',
            'args = ["/old/mcp-stdio-proxy.js"]',
            '',
        ].join('\n'));

        adapter.installMcp({
            sessionKey: 'session-1',
            mcpServerUrl: 'http://localhost/mcp',
        });
        adapter.installMcp({
            sessionKey: 'session-2',
            mcpServerUrl: 'http://localhost/mcp/',
        });

        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(body).toContain('[features]\ncodex_hooks = true');
        expect(body.match(/\[mcp_servers\.slackask\]/g)).toHaveLength(1);
        expect(body).toContain('url = "http://localhost/mcp/session-2"');
        expect(body).not.toContain('[mcp_servers.slack-ask]');
        expect(body).not.toContain('/old/mcp-stdio-proxy.js');
    });

    test('trailing slashes on mcpServerUrl are stripped in config URL', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp//',
        });
        expect(result.launchEnv).toEqual({});
        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(body).toContain('url = "http://127.0.0.1:9998/mcp/test-session"');
    });

    test('missing args produce a no-op with empty env', () => {
        expect(adapter.installMcp()).toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
        expect(adapter.installMcp({ sessionKey: 'x' }))
            .toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
        expect(adapter.installMcp({ mcpServerUrl: 'http://x' }))
            .toEqual({ launchFlag: '', launchEnv: {}, configPath: null });
    });

    test('supports ask_user guidance and leaves global config on uninstall', () => {
        adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });

        expect(adapter.supportsAskUser).toBe(true);
        expect(adapter.askUserGuidance()).toContain('mcp__slackask__.ask_user');
        expect(adapter.uninstallMcp()).toBe(false);
        expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    });
});
