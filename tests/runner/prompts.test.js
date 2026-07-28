const {
    buildReviewPrompt,
    buildApexReviewPrompt,
} = require('../../runner/prompts');

describe('buildReviewPrompt', () => {
    test('contains repo, PR number, result path, and the safety rules', () => {
        const prompt = buildReviewPrompt(
            {
                repo: 'wego/payments',
                pr: 412,
                url: 'https://github.com/wego/payments/pull/412',
            },
            '/Users/enzo/enzobot-jobs/5/result.md',
            '/Users/enzo/go/src/github.com/payments'
        );
        expect(prompt).toContain('wego/payments');
        expect(prompt).toContain('412');
        expect(prompt).toContain('/Users/enzo/enzobot-jobs/5/result.md');
        expect(prompt).toContain('git worktree');
        expect(prompt).toMatch(/do not post|never post/i);
        expect(prompt).toContain('RESULT_READY');
    });
});

describe('buildApexReviewPrompt', () => {
    test('invokes apex-review as draft-only and names the result files', () => {
        const prompt = buildApexReviewPrompt(
            {
                repo: 'wego/payments',
                pr: 412,
                url: 'https://github.com/wego/payments/pull/412',
            },
            '/Users/enzo/enzobot-jobs/9/result.md'
        );
        expect(prompt).toContain('/apex-review');
        expect(prompt).toContain('wego/payments#412');
        expect(prompt).toContain('/Users/enzo/enzobot-jobs/9/result.md');
        expect(prompt).toMatch(/do not post/i);
        expect(prompt).toContain('RESULT_READY');
    });
});
