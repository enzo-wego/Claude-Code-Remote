/**
 * Codex adapter — installMcp / uninstallMcp.
 *
 * Verifies Codex's per-launch HTTP MCP config:
 *   - returns a `-c mcp_servers.slackask.url=...` launch flag
 *   - returns no launch env because Codex owns the HTTP transport
 *   - removes stale global slackask/slack-ask blocks
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

    test('returns per-launch HTTP config for the session', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });

        expect(result.configPath).toBe(null);
        expect(result.launchFlag)
            .toBe("-c 'mcp_servers.slackask.url=http://127.0.0.1:9998/mcp/test-session'");
        expect(result.launchEnv).toEqual({});
    });

    test('preserves existing TOML while removing stale global MCP blocks', () => {
        fs.writeFileSync(CONFIG_PATH, [
            '[features]',
            'codex_hooks = true',
            '',
            '[mcp_servers.slackask]',
            'url = "http://old/mcp/session-1"',
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

        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(body).toContain('[features]\ncodex_hooks = true');
        expect(body).not.toContain('[mcp_servers.slackask]');
        expect(body).not.toContain('[mcp_servers.slack-ask]');
        expect(body).not.toContain('/old/mcp-stdio-proxy.js');
    });

    test('trailing slashes on mcpServerUrl are stripped in launch URL', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp//',
        });
        expect(result.launchEnv).toEqual({});
        expect(result.launchFlag)
            .toBe("-c 'mcp_servers.slackask.url=http://127.0.0.1:9998/mcp/test-session'");
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
    });

    test('askUserToolName returns mcp__slackask__.ask_user (with dot)', () => {
        expect(adapter.askUserToolName()).toBe('mcp__slackask__.ask_user');
    });

    test('uninstallMcpGlobal strips both current and legacy blocks', () => {
        fs.writeFileSync(CONFIG_PATH, [
            '[features]',
            'hooks = true',
            '',
            '[mcp_servers.slackask]',
            'url = "http://x/mcp/a"',
            '',
            '[mcp_servers.slack-ask]',
            'url = "http://x/mcp/legacy"',
            '',
            '[other.section]',
            'kept = "value"',
            '',
        ].join('\n'));
        const result = adapter.uninstallMcpGlobal();
        expect(result.changed).toBe(true);
        const body = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(body).not.toContain('[mcp_servers.slackask]');
        expect(body).not.toContain('[mcp_servers.slack-ask]');
        expect(body).toContain('[features]');
        expect(body).toContain('[other.section]');
    });

    test('uninstallMcpGlobal is a no-op when no blocks present', () => {
        fs.writeFileSync(CONFIG_PATH, '[features]\nhooks = true\n');
        const result = adapter.uninstallMcpGlobal();
        expect(result.changed).toBe(false);
    });
});
