/**
 * herdr pane lifecycle for runner jobs. Etiquette: we operate ONLY inside
 * the workspace labeled 'enzobot' (created on demand). All IDs are read
 * from herdr JSON responses — never constructed. Panes stay open after a
 * job for the owner to inspect.
 */
const { execFileSync } = require('child_process');

const WORKSPACE_LABEL = 'enzobot';

const QUICK_TIMEOUT_MS = 30_000;
// A `herdr wait` blocks for up to its own --timeout, so the subprocess budget
// must always exceed it or execFileSync SIGTERMs a healthy wait mid-flight.
const WAIT_GRACE_MS = 15_000;

function herdr(...args) {
    return herdrWithTimeout(QUICK_TIMEOUT_MS, args);
}

function herdrWithTimeout(timeoutMs, args) {
    const output = execFileSync('herdr', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
    });
    try {
        return JSON.parse(output);
    } catch {
        return output;
    }
}

function paneStatus(paneId) {
    const info = herdr('pane', 'get', paneId);
    return info.result?.pane?.agent_status || 'unknown';
}

/**
 * Wait until a pane reaches `status`.
 *
 * `herdr wait agent-status` is edge-triggered — it blocks for a status
 * *change* — so a pane that already sits at the target status would hang the
 * wait until its timeout. Check the current status first and only block when a
 * transition is genuinely still pending. The subprocess budget always exceeds
 * the herdr timeout so a healthy wait is never SIGTERMed.
 */
function waitStatus(paneId, status, waitMs, alsoAccept = []) {
    const accepted = [status, ...alsoAccept];
    if (accepted.includes(paneStatus(paneId))) return true;
    herdrWithTimeout(waitMs + WAIT_GRACE_MS, [
        'wait',
        'agent-status',
        paneId,
        '--status',
        status,
        '--timeout',
        String(waitMs),
    ]);
    return true;
}

function findWorkspaceByLabel() {
    const list = herdr('workspace', 'list');
    const found = (list.result?.workspaces || [])
        .find(workspace => workspace.label === WORKSPACE_LABEL);
    return found ? found.workspace_id : null;
}

function ensureWorkspace() {
    const existing = findWorkspaceByLabel();
    if (existing) return existing;
    herdr('workspace', 'create', '--label', WORKSPACE_LABEL, '--no-focus');
    // Resolve the id from `workspace list` rather than the create response:
    // the create payload's shape is not guaranteed across herdr versions,
    // while `list` is the authoritative view. Also makes this idempotent.
    const created = findWorkspaceByLabel();
    if (!created) {
        throw new Error(
            `could not resolve herdr workspace '${WORKSPACE_LABEL}' after create`
        );
    }
    return created;
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
    // herdr returns the new tab's first pane under result.root_pane; the
    // other shapes are tolerated in case the payload changes.
    const result = tab.result || {};
    const paneId = result.root_pane?.pane_id
        || result.pane?.pane_id
        || result.pane_id
        || result.panes?.[0]?.pane_id;
    if (!paneId) {
        throw new Error('could not read pane id from tab create response');
    }
    return { paneId, tabId: result.tab?.tab_id || result.tab_id };
}

function startAgent(paneId, cliCommand) {
    herdr('pane', 'run', paneId, cliCommand);
    waitStatus(paneId, 'idle', 60_000);
}

function submitTask(paneId, prompt) {
    herdr('pane', 'run', paneId, prompt);
    // Best-effort: a very fast turn can pass through 'working' before this
    // observes it. waitDone() and the result-file check are the real gates, so
    // never fail the job just because the transition wasn't witnessed.
    try {
        waitStatus(paneId, 'working', 30_000, ['done']);
    } catch {
        // Turn already advanced; fall through to waitDone.
    }
}

function waitDone(paneId, timeoutMs) {
    // A pane the owner is focused on reports 'idle' rather than 'done' when the
    // turn finishes, so either counts as finished.
    try {
        waitStatus(paneId, 'done', timeoutMs, ['idle']);
    } catch {
        waitStatus(paneId, 'idle', 5_000, ['done']);
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
