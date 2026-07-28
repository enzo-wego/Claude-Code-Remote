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
    requestedTeams = [],
    myTeams = [],
    me,
    codeowner = false,
    author = null,
} = {}) {
    // Never review your own PR. GitHub already prevents self-review-requests,
    // so this is belt-and-braces today — but it keeps the guarantee explicit
    // rather than resting on that quirk, and it closes the hole for the
    // codeowner path, which would otherwise match your own PRs.
    if (author && me && author === me) return false;
    if (requestedReviewers.includes(me) || Boolean(codeowner)) return true;

    // A review aimed at a team you belong to is still aimed at you, and it
    // never shows up in requested_reviewers. Compare on slug: requested_teams
    // entries carry one, but not reliably their org.
    const mySlugs = new Set(myTeams.map(team => String(team).split('/').pop()));
    return requestedTeams.some(slug => mySlugs.has(slug));
}

module.exports = { extractPrUrls, needsMyReview };
