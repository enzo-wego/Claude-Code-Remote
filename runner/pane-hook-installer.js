const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_TIMEOUT = 15;

function installPaneHook({ settingsPath, command }) {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    settings.hooks = settings.hooks || {};
    if (settings.hooks.Stop !== undefined
        && !Array.isArray(settings.hooks.Stop)) {
        throw new Error('hooks.Stop must be an array');
    }
    settings.hooks.Stop = settings.hooks.Stop || [];

    const installed = settings.hooks.Stop.some(entry =>
        Array.isArray(entry.hooks)
        && entry.hooks.some(hook =>
            typeof hook.command === 'string'
            && hook.command.includes('pane-notify.js')
        )
    );
    if (installed) {
        return { path: settingsPath, command, changed: false };
    }

    settings.hooks.Stop.push({
        matcher: '*',
        hooks: [{
            type: 'command',
            command,
            timeout: HOOK_TIMEOUT,
        }],
    });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { path: settingsPath, command, changed: true };
}

function quotePath(value) {
    return value.includes(' ') ? `"${value}"` : value;
}

function installDefaultPaneHook({
    homeDir = os.homedir(),
    nodeBin = process.execPath,
} = {}) {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const paneScript = path.join(__dirname, 'pane-notify.js');
    const command = `${quotePath(nodeBin)} ${quotePath(paneScript)}`;
    return installPaneHook({ settingsPath, command });
}

if (require.main === module) {
    try {
        const result = installDefaultPaneHook();
        console.log(
            result.changed
                ? `Pane hook installed in ${result.path}`
                : `Pane hook already installed in ${result.path}`
        );
    } catch (error) {
        console.error(`Pane hook installation failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { installPaneHook, installDefaultPaneHook };
