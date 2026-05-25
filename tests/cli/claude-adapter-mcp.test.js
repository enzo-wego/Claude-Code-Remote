/**
 * Claude adapter — installMcp / uninstallMcp.
 *
 * Verifies the per-session `.mcp.json` generator that Phase 2 Step 4 wires
 * into the tmux launch command:
 *   - writes JSON with the correct mcpServers shape
 *   - URL composes from mcpServerUrl + sessionKey
 *   - launchFlag is `--mcp-config "<path>"` (quoted for safe shelling)
 *   - safeKey sanitization rejects path-traversal in sessionKey
 *   - no-op when args missing
 *   - uninstall removes the file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const adapter = require('../../src/cli/claude-adapter');

const CONFIG_DIR = path.join(os.tmpdir(), 'claude-code-remote-mcp');

function cleanup(sessionKey) {
    const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    try { fs.unlinkSync(path.join(CONFIG_DIR, `claude-${safeKey}.json`)); } catch {}
}

describe('claude-adapter installMcp', () => {
    afterEach(() => cleanup('test-session'));

    test('writes the expected config and returns the --mcp-config flag', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });

        expect(result.configPath).toBe(
            path.join(CONFIG_DIR, 'claude-test-session.json')
        );
        expect(result.launchFlag).toBe(
            `--mcp-config "${result.configPath}"`
        );
        expect(fs.existsSync(result.configPath)).toBe(true);

        const written = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
        expect(written).toEqual({
            mcpServers: {
                'slack-ask': {
                    type: 'http',
                    url: 'http://127.0.0.1:9998/mcp/test-session',
                },
            },
        });
    });

    test('trailing slashes on mcpServerUrl are stripped', () => {
        const result = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp//',
        });
        const written = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
        expect(written.mcpServers['slack-ask'].url)
            .toBe('http://127.0.0.1:9998/mcp/test-session');
    });

    test('sessionKey with path-traversal chars is sanitized in the filename', () => {
        const dirtyKey = '../../etc/passwd';
        const result = adapter.installMcp({
            sessionKey: dirtyKey,
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });
        // safeKey replaces every non-alphanum/_/- with `_`
        expect(result.configPath).toBe(
            path.join(CONFIG_DIR, 'claude-______etc_passwd.json')
        );
        // URL keeps the original (URI-encoded) for the bot's session-id lookup
        const written = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
        expect(written.mcpServers['slack-ask'].url).toContain(encodeURIComponent(dirtyKey));
        // Cleanup uses the same sanitization
        adapter.uninstallMcp({ sessionKey: dirtyKey });
    });

    test('missing args produce a no-op with empty flag', () => {
        expect(adapter.installMcp()).toEqual({ launchFlag: '', configPath: null });
        expect(adapter.installMcp({ sessionKey: 'x' }))
            .toEqual({ launchFlag: '', configPath: null });
        expect(adapter.installMcp({ mcpServerUrl: 'http://x' }))
            .toEqual({ launchFlag: '', configPath: null });
    });

    test('uninstallMcp removes the file (idempotent on missing)', () => {
        const { configPath } = adapter.installMcp({
            sessionKey: 'test-session',
            mcpServerUrl: 'http://127.0.0.1:9998/mcp',
        });
        expect(fs.existsSync(configPath)).toBe(true);
        expect(adapter.uninstallMcp({ sessionKey: 'test-session' })).toBe(true);
        expect(fs.existsSync(configPath)).toBe(false);
        // Second call: file gone → false (not an error).
        expect(adapter.uninstallMcp({ sessionKey: 'test-session' })).toBe(false);
    });
});
