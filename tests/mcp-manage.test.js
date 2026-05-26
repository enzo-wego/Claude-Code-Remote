/**
 * mcp-manage CLI smoke — verifies the status/uninstall subcommands
 * by spawning the script in a child process with a stubbed HOME.
 *
 * The status output is parsed, not asserted exhaustively — what we care
 * about is the exit code and that each registered adapter shows up.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'mcp-manage.js');

function run(args, env = {}) {
    return spawnSync('node', [SCRIPT, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
}

describe('mcp-manage CLI', () => {
    let TMP_HOME;
    beforeEach(() => {
        TMP_HOME = path.join(os.tmpdir(), `mcp-manage-test-${Date.now()}-${Math.random()}`);
        fs.mkdirSync(TMP_HOME, { recursive: true });
    });
    afterEach(() => {
        try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
    });

    test('status with no args prints all adapters', () => {
        const r = run(['status'], { HOME: TMP_HOME, MCP_ENABLED: '' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MCP_ENABLED in env: false');
        expect(r.stdout).toContain('[claude]');
        expect(r.stdout).toContain('[codex]');
        expect(r.stdout).toContain('[gemini]');
        expect(r.stdout).toContain('agent-visible tool:');
    });

    test('status --cli=claude scopes to one adapter', () => {
        const r = run(['status', 'claude'], { HOME: TMP_HOME });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('[claude]');
        expect(r.stdout).not.toContain('[codex]');
    });

    test('status reflects MCP_ENABLED=true', () => {
        const r = run(['status'], { HOME: TMP_HOME, MCP_ENABLED: 'true' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MCP_ENABLED in env: true');
    });

    test('uninstall requires a target', () => {
        const r = run(['uninstall'], { HOME: TMP_HOME });
        expect(r.status).not.toBe(0);
        expect((r.stderr + r.stdout)).toMatch(/requires a CLI name/i);
    });

    test('uninstall claude is a no-op (per-session model)', () => {
        const r = run(['uninstall', 'claude'], { HOME: TMP_HOME });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/no-op|per-session/i);
    });

    test('unknown command shows usage', () => {
        const r = run(['nonsense'], { HOME: TMP_HOME });
        expect(r.status).not.toBe(0);
        expect((r.stderr + r.stdout)).toMatch(/Usage:/i);
    });

    test('unknown CLI is rejected', () => {
        const r = run(['status', 'borg'], { HOME: TMP_HOME });
        expect(r.status).not.toBe(0);
        expect((r.stderr + r.stdout)).toMatch(/Unknown CLI/i);
    });
});
