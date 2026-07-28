/**
 * herdr pane lifecycle for runner jobs. Etiquette: we operate ONLY inside
 * the workspace labeled 'enzobot' (created on demand). All IDs are read
 * from herdr JSON responses — never constructed. Panes stay open after a
 * job for the owner to inspect.
 */
const { execFileSync } = require('child_process');

const WORKSPACE_LABEL = 'enzobot';

function herdr(...args) {
    const output = execFileSync('herdr', args, {
        encoding: 'utf8',
        timeout: 30_000,
    });
    try {
        return JSON.parse(output);
    } catch {
        return output;
    }
}

function ensureWorkspace() {
    const list = herdr('workspace', 'list');
    const found = (list.result?.workspaces || [])
        .find(workspace => workspace.label === WORKSPACE_LABEL);
    if (found) return found.workspace_id;
    const created = herdr(
        'workspace',
        'create',
        '--label',
        WORKSPACE_LABEL,
        '--no-focus'
    );
    return created.result.workspace_id;
}

function createJobPane(workspaceId, { label, cwd }) {
    const tab = herdr(
        'tab',
        'create',
        '--workspace',
        workspaceId,
        '--label',
        label,
        '--cwd',
        cwd,
        '--no-focus'
    );
    const paneId = tab.result.pane_id || tab.result.panes?.[0]?.pane_id;
    if (!paneId) {
        throw new Error('could not read pane id from tab create response');
    }
    return { paneId, tabId: tab.result.tab_id };
}

function startAgent(paneId, cliCommand) {
    herdr('pane', 'run', paneId, cliCommand);
    herdr(
        'wait',
        'agent-status',
        paneId,
        '--status',
        'idle',
        '--timeout',
        '60000'
    );
}

function submitTask(paneId, prompt) {
    herdr('pane', 'run', paneId, prompt);
    herdr(
        'wait',
        'agent-status',
        paneId,
        '--status',
        'working',
        '--timeout',
        '30000'
    );
}

function waitDone(paneId, timeoutMs) {
    try {
        herdr(
            'wait',
            'agent-status',
            paneId,
            '--status',
            'done',
            '--timeout',
            String(timeoutMs)
        );
    } catch {
        herdr(
            'wait',
            'agent-status',
            paneId,
            '--status',
            'idle',
            '--timeout',
            '5000'
        );
    }
}

function readTail(paneId, lines = 200) {
    return herdr(
        'pane',
        'read',
        paneId,
        '--source',
        'recent-unwrapped',
        '--lines',
        String(lines)
    );
}

function closePane(paneId) {
    try {
        herdr('pane', 'close', paneId);
    } catch {
        // Pane is already gone.
    }
}

module.exports = {
    ensureWorkspace,
    createJobPane,
    startAgent,
    submitTask,
    waitDone,
    readTail,
    closePane,
    WORKSPACE_LABEL,
};
