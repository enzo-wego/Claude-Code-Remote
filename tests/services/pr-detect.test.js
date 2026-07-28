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

describe('needsMyReview ignores your own PRs', () => {
    test('false when you authored it, even if somehow requested', () => {
        expect(needsMyReview({
            requestedReviewers: ['enzo'], me: 'enzo', author: 'enzo',
        })).toBe(false);
    });

    test('false when you authored it and the codeowner path would match', () => {
        expect(needsMyReview({
            requestedReviewers: [], me: 'enzo', author: 'enzo', codeowner: true,
        })).toBe(false);
    });

    test('still true for someone else PR requesting you', () => {
        expect(needsMyReview({
            requestedReviewers: ['enzo'], me: 'enzo', author: 'sarah',
        })).toBe(true);
    });
});
