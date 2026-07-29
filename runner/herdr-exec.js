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

/** Synchronous sleep — everything here drives herdr through execFileSync. */
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Poll until the pane reports one of `accepted`, returning whether it did.
 * Unlike waitStatus() this never throws and never blocks in herdr, so it is
 * safe to call in a retry loop where a timeout is an expected outcome.
 */
function pollStatus(paneId, accepted, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (accepted.includes(paneStatus(paneId))) return true;
        if (Date.now() >= deadline) return false;
        sleepMs(500);
    }
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

/**
 * Submit a task and require the agent to visibly start.
 *
 * `pane run` only *types* into a pane that is already running a TUI — it
 * submits nothing. (It works for startAgent because that pane is still a
 * shell.) The prompt therefore sat in Claude's input box at `session:0m`
 * forever, which read as `idle`; waitDone() accepts `idle`, so a
 * never-submitted prompt looked "already finished", the missing result file
 * failed the job, and the retry opened another pane. Enter has to be sent as
 * its own key event.
 *
 * Text stays one line regardless: newlines are typed as literal newlines and
 * would submit only the first fragment.
 */
function submitTask(paneId, prompt) {
    if (prompt.includes('\n')) {
        throw new Error(
            'submitTask needs a single-line prompt; newlines are typed literally into the TUI'
        );
    }
    herdr('pane', 'run', paneId, prompt);

    // `pane run` returns as soon as the text is dispatched, before the TUI has
    // ingested it — an Enter sent right behind it is swallowed and the prompt
    // sits on screen at session:0m forever. Proven both ways on a live pane:
    // immediate Enter did nothing three times running, the same Enter against
    // settled text moved the pane to `working` in seconds.
    //
    // So wait for the text to actually appear, then submit, then confirm the
    // agent started. A lost Enter has no other symptom.
    const marker = prompt.slice(-40);
    const typedBy = Date.now() + 15_000;
    while (Date.now() < typedBy) {
        if (String(readTail(paneId, 15)).includes(marker)) break;
        sleepMs(300);
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        herdr('pane', 'send-keys', paneId, 'Enter');
        // 'done' counts only because a very fast turn can pass through
        // 'working' unobserved. 'idle' must NOT — that is the swallowed-Enter
        // state this whole guard exists to catch.
        if (pollStatus(paneId, ['working', 'done'], 10_000)) return;
    }
    throw new Error(
        `prompt was typed into ${paneId} but Enter never submitted it`
    );
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
