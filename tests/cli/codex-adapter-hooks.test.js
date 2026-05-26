/**
 * Codex adapter hook installation.
 *
 * Verifies the new-machine setup path writes Codex's current hooks feature
 * flag while preserving the rest of ~/.codex/config.toml.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = path.join(os.tmpdir(), `codex-hooks-test-${Date.now()}`);
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const adapter = require('../../src/cli/codex-adapter');

const CODEX_DIR = path.join(TMP_HOME, '.codex');
const CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const HOOKS_PATH = path.join(CODEX_DIR, 'hooks.json');

describe('codex-adapter installHooks', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
        fs.mkdirSync(CODEX_DIR, { recursive: true });
    });

    afterAll(() => {
        if (fs.existsSync(TMP_HOME)) fs.rmSync(TMP_HOME, { recursive: true, force: true });
    });

    test('installs Stop hook and enables current Codex hooks feature', () => {
        fs.writeFileSync(CONFIG_PATH, '[model_providers]\n');

        const result = adapter.installHooks();

        expect(result.path).toBe(HOOKS_PATH);
        expect(result.changed).toBe(true);
        expect(result.featureEnabled).toBe(true);

        const config = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(config).toContain('[model_providers]');
        expect(config).toContain('[features]\nhooks = true');
        expect(config).not.toContain('codex_hooks = true');

        const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
        expect(hooks.hooks.Stop).toHaveLength(1);
        expect(hooks.hooks.Stop[0].hooks[0].command).toContain('cli-hook-notify.js completed');
    });

    test('upgrades existing hooks=false in place', () => {
        fs.writeFileSync(CONFIG_PATH, '[features]\nhooks = false\n');

        adapter.installHooks();

        expect(fs.readFileSync(CONFIG_PATH, 'utf8')).toContain('[features]\nhooks = true');
    });

    test('reports legacy codex_hooks=true as enabled for older installs', () => {
        fs.writeFileSync(CONFIG_PATH, '[features]\ncodex_hooks = true\n');

        expect(adapter.hooksStatus().featureEnabled).toBe(true);

        adapter.installHooks();

        const config = fs.readFileSync(CONFIG_PATH, 'utf8');
        expect(config).toContain('codex_hooks = true');
        expect(config).toContain('hooks = true');
    });
});
