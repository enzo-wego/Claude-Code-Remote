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

describe('refresh button', () => {
    test('board header carries a pr_refresh button even when empty', () => {
        const { buildPrBoardBlocks } = require('../../src/channels/slack/pr-board');
        expect(JSON.stringify(buildPrBoardBlocks([]))).toContain('pr_refresh');
        expect(JSON.stringify(buildPrBoardBlocks([
            { id: 1, repo: 'a/b', number: 1, url: 'u', ci: 'green', review_state: 'requested', status: 'detected' },
        ]))).toContain('pr_refresh');
    });
});
