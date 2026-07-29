const {
    buildPrBoardBlocks,
    buildPrDraftResultBlocks,
} = require('../../src/channels/slack/pr-board');

describe('buildPrBoardBlocks', () => {
    test('renders PR identity, CI/review/status, and status-specific controls', () => {
        const blocks = buildPrBoardBlocks([
            {
                id: 1,
                repo: 'wego/payments',
                number: 412,
                url: 'https://github.com/wego/payments/pull/412',
                title: 'Fix tax rounding',
                ci: 'green',
                review_state: 'requested',
                status: 'needs_review',
            },
            {
                id: 2,
                repo: 'wego/tax',
                number: 7,
                url: 'https://github.com/wego/tax/pull/7',
                title: 'Update invoice schema',
                ci: 'pending',
                review_state: 'requested',
                status: 'reviewing',
            },
            {
                id: 3,
                repo: 'wego/payments',
                number: 413,
                url: 'https://github.com/wego/payments/pull/413',
                title: 'Guard signed discounts',
                ci: 'red',
                review_state: 'reviewed',
                status: 'drafted',
            },
        ]);
        const text = JSON.stringify(blocks);
        expect(text).toContain('Fix tax rounding');
        expect(text).toContain('wego/payments#412');
        expect(text).toContain('🟢');
        expect(text).toContain('🟡');
        expect(text).toContain('🔴');
        expect(text).toContain('requested');
        expect(text).toContain('reviewing on your Mac');

        // The primary action is a row accessory; only secondary controls get
        // their own actions block. Board-level 🔄 Refresh is asserted separately.
        const accessories = blocks
            .filter(block => block.accessory)
            .map(block => ({
                actionId: block.accessory.action_id,
                value: block.accessory.value,
            }));
        expect(accessories).toEqual([
            { actionId: 'pr_review_now', value: '1' },
        ]);

        const actionSets = blocks
            .filter(block => block.type === 'actions')
            .map(block => block.elements.map(element => ({
                actionId: element.action_id,
                value: element.value,
            })))
            .filter(set => !set.some(el => el.actionId === 'pr_refresh'));
        expect(actionSets).toEqual([
            [{ actionId: 'pr_dismiss', value: '1' }],
            [
                { actionId: 'pr_post', value: '3' },
                { actionId: 'pr_edit', value: '3' },
                { actionId: 'pr_discard', value: '3' },
            ],
        ]);
    });
});

describe('buildPrDraftResultBlocks', () => {
    test('renders draft content with PR-specific Post/Edit/Discard buttons', () => {
        const blocks = buildPrDraftResultBlocks({
            id: 3,
            repo: 'wego/payments',
            number: 413,
            url: 'https://github.com/wego/payments/pull/413',
            title: 'Guard signed discounts',
        }, {
            result_json: JSON.stringify({
                summary: '1 blocking',
                body_md: '## Blocking\n- Fix this',
            }),
        });
        const actions = blocks.find(block => block.type === 'actions');
        expect(actions.elements.map(element => element.action_id)).toEqual([
            'pr_post',
            'pr_edit',
            'pr_discard',
        ]);
        expect(actions.elements.every(element => element.value === '3')).toBe(true);
        expect(JSON.stringify(blocks)).toContain('1 blocking');
        expect(JSON.stringify(blocks)).toContain('Fix this');
    });
});

describe('board scope', () => {
    test('carries no page-level controls — those moved to the home view', () => {
        const { buildPrBoardBlocks } = require('../../src/channels/slack/pr-board');
        const text = JSON.stringify(buildPrBoardBlocks([]));
        expect(text).not.toContain('pr_refresh');
        expect(text).not.toContain('home_refresh');
        expect(text).not.toContain('home_toggle_drafts');
        // But it still labels its own lanes.
        expect(text).toContain('Needs my review');
    });
});

describe('draft buttons reflect the verdict', () => {
    const { buildPrDraftResultBlocks } = require('../../src/channels/slack/pr-board');
    const draft = (verdict, lane = 'team') => buildPrDraftResultBlocks(
        { id: 1, repo: 'wego/payments', number: 2210, url: 'u', title: 't', lane },
        { result_json: JSON.stringify({ body_md: 'LGTM', summary: '0 blocking', verdict }) }
    );
    const postBtn = blocks => blocks
        .find(b => b.type === 'actions').elements
        .find(e => e.action_id === 'pr_post');

    test('a clean verdict offers Approve, behind a confirm dialog', () => {
        const btn = postBtn(draft('approve'));
        expect(btn.text.text).toBe('✅ Approve');
        expect(btn.confirm.title.text).toBe('Approve this PR?');
        expect(btn.confirm.text.text).toContain('counts toward its merge');
    });

    test('blocking findings offer Post, with no confirm', () => {
        const btn = postBtn(draft('comment'));
        expect(btn.text.text).toBe('📤 Post');
        expect(btn.confirm).toBeUndefined();
    });

    test('your own PR is never offered Approve', () => {
        expect(postBtn(draft('approve', 'mine')).text.text).toBe('📤 Post');
    });

    test('a draft predating the verdict field falls back to Post', () => {
        expect(postBtn(draft(undefined)).text.text).toBe('📤 Post');
    });
});

describe('the draft DM carries the reviewer report', () => {
    const { buildPrDraftResultBlocks } = require('../../src/channels/slack/pr-board');
    const task = { id: 1, repo: 'wego/payments', number: 2210, url: 'u', title: 't', lane: 'team' };

    const REPORT = [
        '*Apex Review — PR #2210*',
        '',
        '```',
        'Stage                  Status    Evidence',
        'Worktree @ HEAD        invoked   isolated, throwaway branch',
        'deep-review            invoked   9 traces + refutation gate',
        '```',
        '',
        'Verdict is comment, not approve.',
    ].join('\n');

    test('renders the report and keeps the stage table fence intact', () => {
        const blocks = buildPrDraftResultBlocks(task, {
            result_json: JSON.stringify({
                body_md: 'x'.repeat(5433), summary: 's', verdict: 'comment',
                report: REPORT,
                review: { comments: [{ path: 'a.go', line: 2 }, { path: 'b.go', line: 9 }] },
            }),
        });

        expect(blocks[0].type).toBe('header');
        expect(blocks[0].text.text).toBe('Apex Review — wego/payments#2210');

        const text = blocks.filter(b => b.type === 'section')
            .map(b => b.text.text).join('\n\n');
        expect(text).toContain('deep-review');
        // An odd number of fences would mean a table split across blocks.
        expect((text.match(/```/g) || []).length % 2).toBe(0);

        const ctx = blocks.find(b => b.type === 'context').elements[0].text;
        expect(ctx).toContain('verdict *comment*');
        expect(ctx).toContain('2 findings anchored inline');
        expect(ctx).toContain('5433 chars');
    });

    test('every section stays under the Slack 3000-char cap', () => {
        const long = Array.from({ length: 40 },
            (_, i) => `Paragraph ${i} ` + 'y'.repeat(300)).join('\n\n');
        const blocks = buildPrDraftResultBlocks(task, {
            result_json: JSON.stringify({ body_md: '', report: long }),
        });
        const sections = blocks.filter(b => b.type === 'section');
        expect(sections.length).toBeGreaterThan(1);
        for (const s of sections) expect(s.text.text.length).toBeLessThanOrEqual(3000);
        // Nothing may be lost in the split.
        expect(sections.map(s => s.text.text).join('\n\n')).toContain('Paragraph 39');
    });

    test('a fenced block longer than the cap is never split mid-fence', () => {
        const report = 'intro\n\n```\n'
            + Array.from({ length: 60 }, (_, i) => `row ${i} ` + 'z'.repeat(60)).join('\n')
            + '\n```\n\noutro';
        const blocks = buildPrDraftResultBlocks(task, {
            result_json: JSON.stringify({ body_md: '', report }),
        });
        for (const s of blocks.filter(b => b.type === 'section')) {
            expect((s.text.text.match(/```/g) || []).length % 2).toBe(0);
        }
    });

    test('no report falls back to the old summary + preview', () => {
        const blocks = buildPrDraftResultBlocks(task, {
            result_json: JSON.stringify({ body_md: 'REVIEW BODY', summary: '0 blocking' }),
        });
        expect(blocks.some(b => b.type === 'header')).toBe(false);
        expect(JSON.stringify(blocks)).toContain('REVIEW BODY');
    });
});
