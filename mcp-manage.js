#!/usr/bin/env node

/**
 * Manage the MCP slack-ask wiring per CLI — mirrors hooks-manage.js.
 *
 * Each adapter is isolated; targeting one CLI never touches another's config.
 *
 * Usage:
 *   node mcp-manage.js status [claude|codex|gemini|all]
 *   node mcp-manage.js uninstall <claude|codex|gemini|all>
 *
 * Note: there is no `install` subcommand. installMcp runs lazily at each
 * tmux session launch because the per-session URL contains the session id.
 * Run `npm run setup` to set MCP_ENABLED=true (which gates the lazy install).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { getCliAdapter, listAdapters, adapterNames } = require('./src/cli');

function resolveTargets(name) {
    if (!name || name === 'all') return listAdapters();
    const adapter = getCliAdapter(name);
    if (!adapter || adapter.type !== name.toLowerCase()) {
        console.error(`Unknown CLI: "${name}". Available: ${adapterNames().join(', ')}, or "all".`);
        process.exit(1);
    }
    return [adapter];
}

// Detect whether the persistent config file the adapter would normally write
// to currently contains our entry. Cheap diagnostic — best-effort, not
// authoritative. Returns true / false / null (unknown / unreadable).
function detectPresent(adapter) {
    try {
        if (adapter.type === 'claude') {
            // Per-session tmp files. Count anything in the dir.
            const dir = path.join(os.tmpdir(), 'claude-code-remote-mcp');
            if (!fs.existsSync(dir)) return false;
            const matches = fs.readdirSync(dir).filter((f) => f.startsWith('claude-') && f.endsWith('.json'));
            return matches.length > 0 ? `${matches.length} per-session file(s)` : false;
        }
        if (adapter.type === 'codex') {
            const cfg = path.join(os.homedir(), '.codex', 'config.toml');
            if (!fs.existsSync(cfg)) return false;
            const body = fs.readFileSync(cfg, 'utf8');
            return /\[mcp_servers\.slackask\]|\[mcp_servers\.slack-ask\]/.test(body);
        }
        if (adapter.type === 'gemini') {
            const cfg = path.join(os.homedir(), '.gemini', 'settings.json');
            if (!fs.existsSync(cfg)) return false;
            const s = JSON.parse(fs.readFileSync(cfg, 'utf8'));
            return !!(s.mcpServers && s.mcpServers['slack-ask']);
        }
    } catch {
        return null;
    }
    return null;
}

function status(targets) {
    const envEnabled = process.env.MCP_ENABLED === 'true';
    console.log(`MCP_ENABLED in env: ${envEnabled ? 'true' : 'false'}`);
    console.log(`MCP_BIND_HOST: ${process.env.MCP_BIND_HOST || '127.0.0.1 (default)'}`);
    console.log(`MCP_PORT: ${process.env.MCP_PORT || '9998 (default)'}`);
    console.log('');
    for (const adapter of targets) {
        console.log(`[${adapter.type}]`);
        console.log(`  supportsAskUser:        ${!!adapter.supportsAskUser}`);
        console.log(`  installMcp method:      ${typeof adapter.installMcp === 'function'}`);
        console.log(`  uninstallMcpGlobal:     ${typeof adapter.uninstallMcpGlobal === 'function'}`);
        if (typeof adapter.askUserToolName === 'function') {
            console.log(`  agent-visible tool:     ${adapter.askUserToolName()}`);
        }
        const present = detectPresent(adapter);
        const presentStr = present === null
            ? 'unknown'
            : present === false
                ? 'no'
                : (present === true ? 'yes' : `yes (${present})`);
        console.log(`  config has our entry:   ${presentStr}`);
        console.log('');
    }
}

function uninstall(targets) {
    let anyChanged = false;
    for (const adapter of targets) {
        if (typeof adapter.uninstallMcpGlobal !== 'function') {
            console.log(`[${adapter.type}] no uninstallMcpGlobal — skipping`);
            continue;
        }
        const result = adapter.uninstallMcpGlobal();
        if (result && result.changed) {
            anyChanged = true;
            console.log(`[${adapter.type}] removed from ${result.path || '(no path)'}`);
        } else if (result && result.reason) {
            console.log(`[${adapter.type}] no-op: ${result.reason}`);
        } else {
            console.log(`[${adapter.type}] nothing to remove (${(result && result.path) || 'no config'})`);
        }
    }
    if (!anyChanged) console.log('No changes.');
}

function usage() {
    const names = adapterNames().join('|');
    console.log(`Usage: node mcp-manage.js <status|uninstall> <${names}|all>`);
    console.log(`  or:  npm run mcp:status, npm run mcp:uninstall`);
    console.log('');
    console.log('There is no `install` subcommand — installMcp runs lazily at each tmux session');
    console.log('launch because the per-session URL contains the session id. Run `npm run setup`');
    console.log('to enable MCP_ENABLED in .env (which gates the lazy install).');
    process.exit(1);
}

const [, , command, target] = process.argv;
if (!command) usage();

const requiresTarget = command === 'uninstall';
if (requiresTarget && !target) {
    console.error(`"${command}" requires a CLI name so you don't accidentally edit another CLI's config.`);
    usage();
}

const targets = resolveTargets(target || 'all');

switch (command) {
    case 'status':    status(targets);    break;
    case 'uninstall': uninstall(targets); break;
    default:          usage();
}
