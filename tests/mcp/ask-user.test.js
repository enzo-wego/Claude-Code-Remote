/**
 * Tier A — pure unit tests for the MCP ask_user tool.
 *
 * Covers:
 *   - _normalizeInput: shorthand vs questions[], layout auto-pick rules,
 *     default-button injection, value defaulting from label.
 *   - slack-blocks: in-thread render strategies (compact vs CTA), modal
 *     view shape, action_id / callback_id convention.
 *
 * No I/O, no MCP SDK, no Slack. Fast.
 */

const { _normalizeInput, askUserToolDefinition } = require('../../src/mcp/ask-user-tool');
const {
    ACTION_PREFIX,
    buildInThreadBlocks,
    buildModalView,
    buildWizardStepView,
    _modalBlockForQuestion,
    _maybeTruncateBody,
} = require('../../src/mcp/slack-blocks');

// ─── _normalizeInput ──────────────────────────────────────────────────────

describe('_normalizeInput', () => {
    test('one-element questions[] picks layout=single', () => {
        const n = _normalizeInput({
            questions: [{ type: 'select', question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] }],
        });
        expect(n.layout).toBe('single');
        expect(n.questions).toHaveLength(1);
        expect(n.questions[0].type).toBe('select');
        expect(n.questions[0].id).toBeTruthy(); // auto-assigned when omitted
    });

    test('option.value defaults to label when omitted', () => {
        const n = _normalizeInput({
            questions: [{
                type: 'select',
                question: 'Pick',
                options: [{ label: 'Plans only' }, { label: 'Plans + skeleton', value: 'skel' }],
            }],
        });
        expect(n.questions[0].options.map((o) => o.value)).toEqual(['Plans only', 'skel']);
    });

    test('confirm without buttons defaults to primary Yes / danger No', () => {
        const n = _normalizeInput({
            questions: [{ type: 'confirm', question: 'Apply this patch?' }],
        });
        expect(n.questions[0].buttons).toEqual([
            { label: 'Yes', value: 'yes', style: 'primary' },
            { label: 'No', value: 'no', style: 'danger' },
        ]);
    });

    test('select without options throws', () => {
        expect(() =>
            _normalizeInput({ questions: [{ type: 'select', question: 'Pick', options: [] }] })
        ).toThrow(/needs options/);
    });

    test('question without type throws', () => {
        expect(() =>
            _normalizeInput({ questions: [{ id: 'q', question: 'no type' }] })
        ).toThrow(/type is required/);
    });

    test('missing or empty questions[] throws', () => {
        expect(() => _normalizeInput({})).toThrow(/questions\[\] is required/);
        expect(() => _normalizeInput({ questions: [] })).toThrow(/questions\[\] is required/);
    });

    test('two-or-more questions, all input-style, picks layout=single_modal', () => {
        const n = _normalizeInput({
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }] },
                { id: 'b', type: 'text', question: 'B?' },
            ],
        });
        expect(n.layout).toBe('single_modal');
    });

    test('any question with show_if forces layout=wizard', () => {
        const n = _normalizeInput({
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }] },
                { id: 'b', type: 'text', question: 'B?', show_if: { question_id: 'a', equals: 'x' } },
            ],
        });
        expect(n.layout).toBe('wizard');
    });

    test('any preview question forces layout=wizard', () => {
        const n = _normalizeInput({
            questions: [
                { id: 'diff', type: 'preview', question: 'Apply?', body: '+a' },
                { id: 'note', type: 'text', question: 'Why?' },
            ],
        });
        expect(n.layout).toBe('wizard');
    });

    test('explicit layout override is honored', () => {
        const n = _normalizeInput({
            questions: [
                { id: 'a', type: 'select', question: 'A?', options: [{ label: 'x' }] },
                { id: 'b', type: 'text', question: 'B?' },
            ],
            layout: 'wizard',
        });
        expect(n.layout).toBe('wizard');
    });

    test('layout=auto falls through to auto-pick', () => {
        const n = _normalizeInput({
            layout: 'auto',
            questions: [{ type: 'text', question: 'Q?' }],
        });
        expect(n.layout).toBe('single');
    });
});

// ─── Tool definition ──────────────────────────────────────────────────────

describe('askUserToolDefinition', () => {
    test('declares name, description, and a questions[]-required schema', () => {
        expect(askUserToolDefinition.name).toBe('ask_user');
        expect(askUserToolDefinition.description).toMatch(/Slack/i);
        expect(askUserToolDefinition.inputSchema.type).toBe('object');
        expect(askUserToolDefinition.inputSchema.required).toEqual(['questions']);
        expect(askUserToolDefinition.inputSchema.properties.questions.type).toBe('array');
        expect(askUserToolDefinition.inputSchema.properties.questions.minItems).toBe(1);
    });
});

// ─── buildInThreadBlocks ──────────────────────────────────────────────────

describe('buildInThreadBlocks — single-question in-thread renders', () => {
    test('compact select (≤4 options, no descriptions, single-select) becomes a button row', () => {
        const q = {
            id: 'q',
            type: 'select',
            question: 'Yes or no?',
            options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
        };
        const r = buildInThreadBlocks('req-1', q);
        const actions = r.blocks.find((b) => b.type === 'actions');
        expect(actions.elements).toHaveLength(2);
        expect(actions.elements[0].action_id).toBe(`${ACTION_PREFIX}:req-1:q:btn:yes`);
        expect(actions.elements[0].text.text).toBe('Yes');
    });

    test('select with descriptions falls back to non-compact "Open picker" CTA', () => {
        const q = {
            id: 'q',
            type: 'select',
            question: 'Pick scope',
            options: [
                { label: 'Plans only', description: 'No code.', value: 'plans' },
                { label: 'Plans + PR', description: 'End-to-end.', value: 'full' },
            ],
        };
        const r = buildInThreadBlocks('req-2', q);
        const actions = r.blocks.find((b) => b.type === 'actions');
        expect(actions.elements[0].action_id).toBe(`${ACTION_PREFIX}:req-2:q:btn:__open_modal__`);
    });

    test('confirm renders one button per entry with correct styles', () => {
        const q = {
            id: 'q',
            type: 'confirm',
            question: 'Apply?',
            buttons: [
                { label: 'Approve', value: 'approve', style: 'primary' },
                { label: 'Approve+remember', value: 'approve_pat' },
                { label: 'Deny', value: 'deny', style: 'danger' },
            ],
        };
        const r = buildInThreadBlocks('req-3', q);
        const els = r.blocks.find((b) => b.type === 'actions').elements;
        expect(els).toHaveLength(3);
        expect(els[0].style).toBe('primary');
        expect(els[1].style).toBeUndefined();
        expect(els[2].style).toBe('danger');
    });

    test('preview renders the body inside a code block and defaults to Approve/Reject', () => {
        const q = {
            id: 'q',
            type: 'preview',
            question: 'Apply this diff?',
            body: '+foo\n-bar',
            language: 'diff',
        };
        const r = buildInThreadBlocks('req-4', q);
        const code = r.blocks.find((b) =>
            b.type === 'section' && b.text.text.includes('```diff')
        );
        expect(code).toBeDefined();
        const els = r.blocks.find((b) => b.type === 'actions').elements;
        expect(els.map((e) => e.text.text)).toEqual(['Approve', 'Reject']);
    });

    test('text question offers "Open editor" CTA for the multiline modal path', () => {
        const q = { id: 'q', type: 'text', question: 'Why?' };
        const r = buildInThreadBlocks('req-5', q);
        const els = r.blocks.find((b) => b.type === 'actions').elements;
        expect(els[0].action_id).toBe(`${ACTION_PREFIX}:req-5:q:btn:__open_text_modal__`);
    });
});

// ─── buildModalView ───────────────────────────────────────────────────────

describe('buildModalView — multi-question modal', () => {
    test('emits one input block per question and a submit callback_id', () => {
        const v = buildModalView(
            'req-6',
            [
                { id: 'pkg', type: 'select', question: 'Pkg', options: [{ label: 'a', value: 'a' }] },
                { id: 'note', type: 'text', question: 'Note', multiline: true },
            ],
            { title: 'Wizard' },
        );
        expect(v.type).toBe('modal');
        expect(v.callback_id).toBe(`${ACTION_PREFIX}:req-6:submit`);
        expect(JSON.parse(v.private_metadata)).toEqual({ requestId: 'req-6' });
        expect(v.blocks.filter((b) => b.type === 'input')).toHaveLength(2);
    });

    test('single-select inside a modal uses radio_buttons, multi uses checkboxes', () => {
        const radio = _modalBlockForQuestion('req-7', {
            id: 'q', type: 'select', question: 'Q', options: [{ label: 'a', value: 'a' }],
        });
        const checks = _modalBlockForQuestion('req-7', {
            id: 'q', type: 'select', question: 'Q', multi: true, options: [{ label: 'a', value: 'a' }],
        });
        expect(radio[0].element.type).toBe('radio_buttons');
        expect(checks[0].element.type).toBe('checkboxes');
    });

    test('preview inside a modal lays out as: section + code + radio decision', () => {
        const blocks = _modalBlockForQuestion('req-8', {
            id: 'q', type: 'preview', question: 'Apply?', body: '+a\n-b',
            buttons: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
        });
        expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'input']);
        expect(blocks[2].element.type).toBe('radio_buttons');
    });
});

// ─── buildWizardStepView ──────────────────────────────────────────────────

describe('buildWizardStepView — wizard step modal', () => {
    test('first step shows Next + Cancel, last step shows Submit + Back', () => {
        const first = buildWizardStepView('r', { id: 'q', type: 'text', question: 'Q' }, {
            step: 0, totalSteps: 3, isLast: false, hasPrev: false,
        });
        expect(first.submit.text).toBe('Next');
        expect(first.close.text).toBe('Cancel');

        const last = buildWizardStepView('r', { id: 'q', type: 'text', question: 'Q' }, {
            step: 2, totalSteps: 3, isLast: true, hasPrev: true,
        });
        expect(last.submit.text).toBe('Submit');
        expect(last.close.text).toBe('Back');
    });

    test('private_metadata carries step index for the resume handler', () => {
        const v = buildWizardStepView('r', { id: 'q', type: 'text', question: 'Q' }, {
            step: 1, totalSteps: 3, isLast: false, hasPrev: true,
        });
        expect(JSON.parse(v.private_metadata)).toEqual({ requestId: 'r', step: 1 });
    });
});

// ─── Body truncation ──────────────────────────────────────────────────────

describe('_maybeTruncateBody', () => {
    test('returns body unchanged when below the cap', () => {
        expect(_maybeTruncateBody('hi', 10)).toEqual({ body: 'hi', didTruncate: false });
    });

    test('truncates by line count when truncate_after_lines is given', () => {
        const r = _maybeTruncateBody('a\nb\nc\nd\ne', 3);
        expect(r.didTruncate).toBe(true);
        expect(r.body).toBe('a\nb\nc\n…');
    });

    test('falls back to char-cap (~2800) when no line cap is given', () => {
        const big = 'x'.repeat(3500);
        const r = _maybeTruncateBody(big);
        expect(r.didTruncate).toBe(true);
        expect(r.body.length).toBeLessThanOrEqual(2802); // 2800 + "\n…"
    });
});
