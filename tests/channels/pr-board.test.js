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
