const fs = require('fs');
const os = require('os');
const path = require('path');
const { installPaneHook } = require('../../runner/pane-hook-installer');

describe('pane hook installer', () => {
    test('appends to hooks.Stop without replacing the existing hook', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-hook-'));
        const settingsPath = path.join(directory, 'settings.json');
        const existing = {
            hooks: {
                Stop: [{
                    matcher: '*',
                    hooks: [{
                        type: 'command',
                        command: '/other-project/memory-sync-stop.sh',
                        timeout: 30,
                    }],
                }],
            },
        };
        fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

        const first = installPaneHook({
            settingsPath,
            command: '/node /repo/runner/pane-notify.js',
        });
        const second = installPaneHook({
            settingsPath,
            command: '/node /repo/runner/pane-notify.js',
        });
        const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(written.hooks.Stop).toHaveLength(2);
        expect(written.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
        expect(written.hooks.Stop[1]).toEqual({
            matcher: '*',
            hooks: [{
                type: 'command',
                command: '/node /repo/runner/pane-notify.js',
                timeout: 15,
            }],
        });
    });
});
