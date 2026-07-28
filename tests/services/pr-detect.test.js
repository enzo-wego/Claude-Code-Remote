const { extractPrUrls, needsMyReview } = require('../../src/services/pr-detect');

describe('pr-detect', () => {
    test('extracts github PR urls from slack text (angle-bracketed too)', () => {
        const text = 'pls review <https://github.com/wego/payments/pull/412> and https://github.com/wego/tax/pull/7';
        expect(extractPrUrls(text)).toEqual([
            {
                repo: 'wego/payments',
                number: 412,
                url: 'https://github.com/wego/payments/pull/412',
            },
            {
                repo: 'wego/tax',
                number: 7,
                url: 'https://github.com/wego/tax/pull/7',
            },
        ]);
    });

    test('needsMyReview: true when review requested from me OR I am code-owner', () => {
        expect(needsMyReview({
            requestedReviewers: ['enzo'],
            me: 'enzo',
        })).toBe(true);
        expect(needsMyReview({
            requestedReviewers: ['bob'],
            me: 'enzo',
            codeowner: true,
        })).toBe(true);
        expect(needsMyReview({
            requestedReviewers: ['bob'],
            me: 'enzo',
        })).toBe(false);
    });
});
