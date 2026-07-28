const { buildPrBoardBlocks } = require('../../src/channels/slack/pr-board');

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
        expect(text).toContain('needs_review');
        expect(text).toContain('reviewing on your Mac');

        const actionSets = blocks
            .filter(block => block.type === 'actions')
            .map(block => block.elements.map(element => ({
                actionId: element.action_id,
                value: element.value,
            })));
        expect(actionSets).toEqual([
            [
                { actionId: 'pr_review_now', value: '1' },
                { actionId: 'pr_dismiss', value: '1' },
            ],
            [
                { actionId: 'pr_post', value: '3' },
                { actionId: 'pr_edit', value: '3' },
                { actionId: 'pr_discard', value: '3' },
            ],
        ]);
    });
});
