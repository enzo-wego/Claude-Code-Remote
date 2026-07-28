function extractPrUrls(text) {
    const results = [];
    const seen = new Set();
    const normalized = String(text || '').replace(/[<>]/g, ' ');
    const pattern = /https?:\/\/github\.com\/([^/\s|]+\/[^/\s|]+)\/pull\/(\d+)/gi;

    for (const match of normalized.matchAll(pattern)) {
        const repo = match[1];
        const number = Number(match[2]);
        const key = `${repo.toLowerCase()}#${number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
            repo,
            number,
            url: `https://github.com/${repo}/pull/${number}`,
        });
    }

    return results;
}

function needsMyReview({
    requestedReviewers = [],
    me,
    codeowner = false,
    author = null,
} = {}) {
    // Never review your own PR. GitHub already prevents self-review-requests,
    // so this is belt-and-braces today — but it keeps the guarantee explicit
    // rather than resting on that quirk, and it closes the hole for the
    // codeowner path, which would otherwise match your own PRs.
    if (author && me && author === me) return false;
    return requestedReviewers.includes(me) || Boolean(codeowner);
}

module.exports = { extractPrUrls, needsMyReview };
