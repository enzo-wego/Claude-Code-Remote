/**
 * Phase 3 — wizard step machinery + show_if branching.
 *
 * Pure unit coverage of the navigation logic (no MCP transport, no Slack).
 * The poster module exposes its internal helpers under _-prefixed names
 * for direct testing.
 */

const askUserTool = require('../../src/mcp/ask-user-tool');
const poster = require('../../src/mcp/poster');
const { ACTION_PREFIX } = require('../../src/mcp/slack-blocks');

const { _findNextVisibleStep, _shouldShowQuestion, _handleViewSubmission } = poster;

// ─── show_if + step navigation ─────────────────────────────────────────────

describe('shouldShowQuestion', () => {
    test('returns true when no show_if', () => {
        expect(_shouldShowQuestion({ id: 'q' }, {})).toBe(true);
    });

    test('returns false when the referenced answer is missing', () => {
        const q = { id: 'b', show_if: { question_id: 'a', equals: 'x' } };
        expect(_shouldShowQuestion(q, {})).toBe(false);
    });

    test('equals: shows only on exact match', () => {
        const q = { id: 'b', show_if: { question_id: 'a', equals: 'x' } };
        expect(_shouldShowQuestion(q, { a: 'x' })).toBe(true);
        expect(_shouldShowQuestion(q, { a: 'y' })).toBe(false);
    });

    test('in: shows when answer is in the allowlist', () => {
        const q = { id: 'b', show_if: { question_id: 'a', in: ['x', 'z'] } };
        expect(_shouldShowQuestion(q, { a: 'x' })).toBe(true);
        expect(_shouldShowQuestion(q, { a: 'y' })).toBe(false);
        expect(_shouldShowQuestion(q, { a: 'z' })).toBe(true);
    });

    test('both equals and in present: AND', () => {
        const q = { id: 'b', show_if: { question_id: 'a', equals: 'x', in: ['x', 'y'] } };
        expect(_shouldShowQuestion(q, { a: 'x' })).toBe(true);
        expect(_shouldShowQuestion(q, { a: 'y' })).toBe(false);
    });
});

describe('findNextVisibleStep', () => {
    test('returns from when from is already visible', () => {
        const qs = [
            { id: 'a', type: 'select' },
            { id: 'b', type: 'text' },
        ];
        expect(_findNextVisibleStep(qs, 0, {})).toBe(0);
        expect(_findNextVisibleStep(qs, 1, {})).toBe(1);
    });

    test('skips over questions whose show_if is false', () => {
        const qs = [
            { id: 'a', type: 'select' },
            { id: 'b', type: 'text', show_if: { question_id: 'a', equals: 'x' } },
            { id: 'c', type: 'text' },
        ];
        // a=y → skip b, go to c
        expect(_findNextVisibleStep(qs, 1, { a: 'y' })).toBe(2);
        // a=x → b is visible
        expect(_findNextVisibleStep(qs, 1, { a: 'x' })).toBe(1);
    });

    test('returns length when nothing else qualifies (done)', () => {
        const qs = [
            { id: 'a', type: 'select' },
            { id: 'b', type: 'text', show_if: { question_id: 'a', equals: 'x' } },
        ];
        expect(_findNextVisibleStep(qs, 1, { a: 'y' })).toBe(2);
    });
});

// ─── handleViewSubmission — wizard step navigation ─────────────────────────

describe('handleViewSubmission for wizard layout', () => {
    let requestId;
    let baseEntry;

    beforeEach(() => {
        requestId = 'req-test';
        // Seed a pending entry directly. Tests don't go through handleAskUser
        // because it requires a real DB row + Slack post.
        baseEntry = {
            resolve: jest.fn(),
            reject: jest.fn(),
            sessionId: 'sess',
            channel: 'C',
            threadTs: 'T',
            layout: 'wizard',
            questions: [
                { id: 'pkg',  type: 'select', question: 'Pkg?', options: [{ label: 'a', value: 'a' }] },
                { id: 'note', type: 'text', question: 'Note?' },
                { id: 'go',   type: 'confirm', question: 'Go?', buttons: [{ label: 'Yes', value: 'yes' }] },
            ],
            answers: {},
            step: 0,
            title: 'Wizard',
            submitLabel: 'Submit',
            timeout: setTimeout(() => {}, 60000),
        };
        // Stash directly into the registry.
        require('../../src/mcp/ask-user-tool')
            ._normalizeInput; // keep require warm
        // Use the public API to create a pending entry — call setPendingAnswers etc.
        // Simpler: poke pending via getPending side effect — but we can't reach
        // the Map. Workaround: use an internal trick — set up a fake pending via
        // a small helper.
        injectPending(requestId, baseEntry);
    });

    afterEach(() => {
        clearTimeout(baseEntry.timeout);
        askUserTool.cancelPending(requestId, 'cancelled');
    });

    test('intermediate step submission returns response_action=update with next view', async () => {
        // User submits step 0 (pkg=a)
        const view = mockWizardSubmissionView({
            requestId,
            step: 0,
            answers: { pkg: 'a' },
        });
        const result = await _handleViewSubmission({ body: {}, view });

        expect(result).toBeTruthy();
        expect(result.response_action).toBe('update');
        // Next step's view callback_id should still be wizard.
        expect(result.view.callback_id).toBe(`${ACTION_PREFIX}:${requestId}:wizard`);
        // private_metadata carries the new step index (1).
        expect(JSON.parse(result.view.private_metadata).step).toBe(1);
        // Accumulated answer is captured.
        expect(askUserTool.getPending(requestId).answers).toEqual({ pkg: 'a' });
    });

    test('last step submission resolves the MCP call and closes the modal', async () => {
        // Pretend we already submitted steps 0 and 1
        askUserTool.setPendingAnswers(requestId, { pkg: 'a', note: 'hi' });
        askUserTool.advancePendingStep(requestId, 2);

        const view = mockWizardSubmissionView({
            requestId,
            step: 2,
            answers: { go: 'yes' },
        });
        const result = await _handleViewSubmission({ body: {}, view });

        expect(result).toBeNull(); // null → ack closes the modal
        // resolve was called with merged answers
        expect(baseEntry.resolve).toHaveBeenCalledTimes(1);
        expect(baseEntry.resolve.mock.calls[0][0]).toEqual({
            answers: { pkg: 'a', note: 'hi', go: 'yes' },
            status: 'ok',
        });
        // Entry is gone from pending after resolve
        expect(askUserTool.getPending(requestId)).toBeNull();
    });

    test('show_if skip: step submission jumps past hidden questions', async () => {
        // Replace questions with a branching shape: q2 is gated on q1=='x'.
        askUserTool.cancelPending(requestId, 'cancelled');
        baseEntry = {
            ...baseEntry,
            resolve: jest.fn(),
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }, { label: 'y' }] },
                { id: 'b', type: 'text', question: 'B?', show_if: { question_id: 'a', equals: 'x' } },
                { id: 'c', type: 'text', question: 'C?' },
            ],
            answers: {},
            step: 0,
        };
        injectPending(requestId, baseEntry);

        // User submits a='y' → b should be skipped → next view = c (step 2)
        const view = mockWizardSubmissionView({
            requestId,
            step: 0,
            answers: { a: 'y' },
        });
        const result = await _handleViewSubmission({ body: {}, view });

        expect(result.response_action).toBe('update');
        expect(JSON.parse(result.view.private_metadata).step).toBe(2);
        expect(askUserTool.getPending(requestId).step).toBe(2);
    });

    test('show_if true keeps next step in the chain', async () => {
        askUserTool.cancelPending(requestId, 'cancelled');
        baseEntry = {
            ...baseEntry,
            resolve: jest.fn(),
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }, { label: 'y' }] },
                { id: 'b', type: 'text', question: 'B?', show_if: { question_id: 'a', equals: 'x' } },
            ],
            answers: {},
            step: 0,
        };
        injectPending(requestId, baseEntry);

        const view = mockWizardSubmissionView({
            requestId,
            step: 0,
            answers: { a: 'x' },
        });
        const result = await _handleViewSubmission({ body: {}, view });
        expect(JSON.parse(result.view.private_metadata).step).toBe(1);
    });

    test('all remaining steps hidden after current → resolve immediately', async () => {
        askUserTool.cancelPending(requestId, 'cancelled');
        baseEntry = {
            ...baseEntry,
            resolve: jest.fn(),
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }, { label: 'y' }] },
                { id: 'b', type: 'text', question: 'B?', show_if: { question_id: 'a', equals: 'x' } },
            ],
            answers: {},
            step: 0,
        };
        injectPending(requestId, baseEntry);

        // a='y' → b's show_if fails → no more visible → resolve
        const view = mockWizardSubmissionView({
            requestId,
            step: 0,
            answers: { a: 'y' },
        });
        const result = await _handleViewSubmission({ body: {}, view });

        expect(result).toBeNull();
        expect(baseEntry.resolve).toHaveBeenCalledTimes(1);
        expect(baseEntry.resolve.mock.calls[0][0]).toEqual({
            answers: { a: 'y' },
            status: 'ok',
        });
    });
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** Reach into the ask-user-tool module's pending registry. */
function injectPending(requestId, entry) {
    // Use the public API to set + advance, but the resolve/reject closure
    // is what we want to spy on, so we have to poke the Map directly.
    // The module doesn't expose its Map, so we re-require with a helper.
    // Simplest path: monkey-patch by calling getPending on a freshly-created
    // entry via the internal Map. Since we don't have direct access, fallback
    // to using the module's exported helpers in a controlled way.
    //
    // Pragmatic: stash a getter by manipulating require cache.
    const askUserToolMod = require('../../src/mcp/ask-user-tool');
    // The module-level `pending` Map isn't exported. We expose `getPending`,
    // `setPendingAnswers`, `advancePendingStep`, `cancelPending`. To inject,
    // we use a tiny trick: call cancelPending first (no-op if missing) then
    // monkey-set via Object.defineProperty on an internal reference.
    //
    // Cleaner: tests/mcp/loopback.test.js already calls resolvePending from
    // outside, so the pattern is supported. We need an injector — add one
    // if absent. For now, monkey-patch via a require-time hook.

    // Use the internal Map via require cache mutation:
    const mod = require.cache[require.resolve('../../src/mcp/ask-user-tool')];
    // Walk the module's source to find the `pending` Map. It's a closed-over
    // variable, not on exports. We can't access it directly without an exported
    // hook, so add one: read the module's internal state via a tagged helper.
    //
    // Cleanest: use the existing setPendingAnswers/advancePendingStep, but
    // those require the entry to already exist. So instead, register the
    // entry via the legitimate path:
    //   1. fake a tools/call by manually invoking handleAskUser — but it
    //      requires DB + Slack, too heavy.
    //
    // Resort to a small dedicated test helper: add `_injectPendingForTests`
    // to the module. (Cleaner than monkey-patching require.cache.)
    if (!askUserToolMod._injectPendingForTests) {
        throw new Error(
            'ask-user-tool missing _injectPendingForTests helper — Phase 3 test scaffolding incomplete.',
        );
    }
    askUserToolMod._injectPendingForTests(requestId, entry);
}

/** Build a fake view_submission view object for a wizard step. */
function mockWizardSubmissionView({ requestId, step, answers }) {
    const values = {};
    for (const [qid, val] of Object.entries(answers)) {
        const blockId = `${ACTION_PREFIX}:${requestId}:${qid}`;
        values[blockId] = {
            [`${blockId}:any`]: {
                // shape varies per element type; cover both selected_option and
                // plain string-value so extractAnswerValue works.
                value: val,
                selected_option: { value: val, text: { type: 'plain_text', text: val } },
            },
        };
    }
    return {
        callback_id: `${ACTION_PREFIX}:${requestId}:wizard`,
        private_metadata: JSON.stringify({ requestId, step }),
        state: { values },
    };
}
