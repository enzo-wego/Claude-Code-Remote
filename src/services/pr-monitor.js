const GITHUB_API = 'https://api.github.com';

const FAILURE_STATES = new Set([
    'action_required',
    'cancelled',
    'error',
    'failure',
    'startup_failure',
    'timed_out',
]);

const SUCCESS_STATES = new Set([
    'neutral',
    'skipped',
    'success',
]);

function mapCiState(checks) {
    const rows = Array.isArray(checks)
        ? checks
        : checks?.check_runs || checks?.statuses || [];
    if (rows.length === 0) return 'pending';

    const states = rows.map(check => {
        if (check.state) return String(check.state).toLowerCase();
        if (check.status && check.status !== 'completed') return 'pending';
        return String(check.conclusion || 'pending').toLowerCase();
    });

    if (states.some(state => FAILURE_STATES.has(state))) return 'red';
    if (states.some(state => !SUCCESS_STATES.has(state))) return 'pending';
    return 'green';
}

function githubHeaders(token) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'enzobot',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function githubJson(url, token) {
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) {
        throw new Error(`GitHub ${response.status} for ${url}`);
    }
    return response.json();
}

/** Team slugs (`org/slug`) the token owner belongs to. */
async function fetchViewerTeams(token) {
    const teams = await githubJson(`${GITHUB_API}/user/teams?per_page=100`, token);
    return (Array.isArray(teams) ? teams : [])
        .map(team => {
            const org = team.organization?.login;
            return org && team.slug ? `${org}/${team.slug}` : null;
        })
        .filter(Boolean);
}

/**
 * Search qualifiers that together cover "PRs I should look at".
 *
 * `review-requested:@me` only matches PRs where you were named individually —
 * a request aimed at a team you belong to is NOT included, so relying on it
 * alone silently hides most team review traffic. One qualifier per team closes
 * that.
 */
function reviewQueries(teams = []) {
    return [
        'review-requested:@me',
        ...teams.map(team => `team-review-requested:${team}`),
    ];
}

function parsePrUrl(htmlUrl) {
    const match = String(htmlUrl || '')
        .match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return match ? { repo: match[1], number: Number(match[2]) } : null;
}

async function searchPrs(qualifier, token) {
    const query = `is:pr is:open archived:false ${qualifier}`;
    const data = await githubJson(
        `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=50`,
        token
    );
    return data.items || [];
}

async function fetchPrState({ repo, number, token, viewerLogin, viewerTeams = [] }) {
    const pull = await githubJson(
        `${GITHUB_API}/repos/${repo}/pulls/${number}`,
        token
    );
    const checksUrl = `${GITHUB_API}/repos/${repo}/commits/${pull.head.sha}/check-runs`;
    let checks;
    try {
        checks = await githubJson(checksUrl, token);
    } catch {
        checks = await githubJson(
            `${GITHUB_API}/repos/${repo}/commits/${pull.head.sha}/status`,
            token
        );
    }

    const requestedReviewers = (pull.requested_reviewers || [])
        .map(reviewer => reviewer.login)
        .filter(Boolean);
    // `requested_teams[]` entries carry a slug but not always their org, so
    // match on the slug alone.
    const requestedTeams = (pull.requested_teams || [])
        .map(team => team.slug)
        .filter(Boolean);
    const mySlugs = new Set(viewerTeams.map(team => String(team).split('/').pop()));

    // GitHub drops you from requested_reviewers once you submit a review, so
    // presence there is the signal. Scope it to the owner when we know who
    // that is — another reviewer still being pending is not our business.
    // (`pull.review_state` / `pull.reviewed` do not exist on this payload.)
    const meRequested = viewerLogin
        ? requestedReviewers.includes(viewerLogin)
        : requestedReviewers.length > 0;
    const teamRequested = requestedTeams.some(slug => mySlugs.has(slug));

    return {
        ci: mapCiState(checks),
        reviewState: meRequested || teamRequested ? 'requested' : 'none',
        title: pull.title || null,
        author: pull.user?.login || null,
        requestedReviewers,
        requestedTeams,
        // Free with this call — the watermark for "did anyone reply".
        comments: Number(pull.comments || 0) + Number(pull.review_comments || 0),
        draft: Boolean(pull.draft),
        // A PR that left GitHub's queue should leave the board too.
        closed: pull.state === 'closed',
        merged: Boolean(pull.merged_at),
    };
}

/**
 * Who has weighed in, and how. GitHub's REST pull payload has no review
 * decision field, so derive it the way GitHub does: only APPROVED and
 * CHANGES_REQUESTED are decisive, latest one per reviewer wins, and your own
 * reviews never count.
 */
async function fetchReviewDecision({ repo, number, token, viewerLogin }) {
    const reviews = await githubJson(
        `${GITHUB_API}/repos/${repo}/pulls/${number}/reviews?per_page=100`,
        token
    );
    const latest = new Map();
    let commented = null;

    for (const review of Array.isArray(reviews) ? reviews : []) {
        const who = review.user?.login;
        if (!who || (viewerLogin && who === viewerLogin)) continue;
        const state = String(review.state || '').toUpperCase();
        if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
            latest.set(who, state);
        } else if (state === 'COMMENTED') {
            commented = commented || who;
        }
    }

    const entries = [...latest.entries()];
    const blocking = entries.find(([, state]) => state === 'CHANGES_REQUESTED');
    if (blocking) {
        return { decision: 'changes_requested', decisionBy: blocking[0] };
    }
    const approval = entries.find(([, state]) => state === 'APPROVED');
    if (approval) return { decision: 'approved', decisionBy: approval[0] };
    if (commented) return { decision: 'commented', decisionBy: commented };
    return { decision: null, decisionBy: null };
}

async function fetchViewerLogin(token) {
    const viewer = await githubJson(`${GITHUB_API}/user`, token);
    if (!viewer.login) {
        throw new Error('GitHub /user response did not include login');
    }
    return viewer.login;
}

/**
 * Discover PRs awaiting the owner's review straight from GitHub.
 *
 * Without this the board only ever learns about PRs that happen to be pasted
 * into Slack, so a fresh start (or any PR nobody linked) is invisible. Runs on
 * every monitor cycle, so it also seeds the board immediately after a restart.
 *
 * upsert() never touches `status`, so a PR the owner already dismissed or
 * finished stays retired instead of reappearing each sweep.
 */
async function sweepReviewRequests(prTasks, token, { teams = [], viewerLogin } = {}) {
    const seeded = [];
    const seen = new Set();

    for (const qualifier of reviewQueries(teams)) {
        // One team's query failing (deleted team, missing scope) must not cost
        // us the other queries' results.
        let items;
        try {
            items = await searchPrs(`${qualifier} draft:false`, token);
        } catch (err) {
            if (qualifier === 'review-requested:@me') throw err;
            continue;
        }

        for (const item of items) {
            const pull = parsePrUrl(item.html_url);
            if (!pull) continue;
            const author = item.user?.login || null;
            // `review-requested:@me` can never return your own PR, but
            // `team-review-requested:` can — you are allowed to ask your own
            // team to review your work. Without this the review lane would
            // pick up your PRs and auto-review could fire on them.
            if (viewerLogin && author === viewerLogin) continue;
            const key = `${pull.repo.toLowerCase()}#${pull.number}`;
            if (seen.has(key)) continue;
            seen.add(key);
            seeded.push(prTasks.upsert({
                ...pull,
                url: item.html_url,
                title: item.title || null,
                author,
                reviewState: 'requested',
                origin: 'github-sweep',
                lane: 'review',
            }));
        }
    }

    return seeded;
}

/**
 * The other half of the board: PRs the owner opened, where the wait is on
 * everyone else. Drafts are included — you still want to know if someone
 * commented on one.
 */
async function sweepMyPrs(prTasks, token) {
    const items = await searchPrs('author:@me', token);
    const seeded = [];
    for (const item of items) {
        const pull = parsePrUrl(item.html_url);
        if (!pull) continue;
        seeded.push(prTasks.upsert({
            ...pull,
            url: item.html_url,
            title: item.title || null,
            author: item.user?.login || null,
            origin: 'github-mine',
            lane: 'mine',
        }));
    }
    return seeded;
}

async function refreshAll(prTasks, token, viewerLogin, viewerTeams = []) {
    const readyBefore = new Set(
        prTasks.reviewReady().map(task => task.id)
    );

    for (const task of prTasks.listActive('review')) {
        const state = await fetchPrState({
            repo: task.repo,
            number: task.number,
            token,
            viewerLogin,
            viewerTeams,
        });
        if (state.closed) {
            // Merged or closed on GitHub — the review is moot, so retire the
            // card instead of leaving stale work on the board.
            prTasks.setStatus(task.id, 'closed');
            continue;
        }
        prTasks.upsert({
            repo: task.repo,
            number: task.number,
            url: task.url,
            title: state.title,
            author: state.author,
            ci: state.ci,
            reviewState: state.reviewState,
            origin: task.origin,
            lane: 'review',
        });
    }

    return prTasks.reviewReady()
        .filter(task => !readyBefore.has(task.id));
}

/**
 * Refresh the owner's own PRs and report what changed since last cycle, so the
 * caller can speak up only when a teammate actually did something.
 */
async function refreshMine(prTasks, token, viewerLogin) {
    const changed = [];

    for (const task of prTasks.listActive('mine')) {
        const state = await fetchPrState({
            repo: task.repo,
            number: task.number,
            token,
            viewerLogin,
        });
        if (state.closed) {
            prTasks.setStatus(task.id, 'closed');
            continue;
        }

        const { decision, decisionBy } = await fetchReviewDecision({
            repo: task.repo,
            number: task.number,
            token,
            viewerLogin,
        });

        prTasks.upsert({
            repo: task.repo,
            number: task.number,
            url: task.url,
            title: state.title,
            author: state.author,
            ci: state.ci,
            origin: task.origin,
            lane: 'mine',
        });

        // ponytail: comment count includes your own replies, so a self-reply
        // reads as activity. Upgrade path if that grates: page
        // /issues/{n}/comments and filter by author.
        const newComments = Math.max(0, state.comments - (task.seen_comments || 0));
        const decisionChanged = (decision || null) !== (task.review_decision || null);

        prTasks.setMineState(task.id, {
            reviewDecision: decision,
            decisionBy,
            seenComments: state.comments,
        });

        // A first sighting is not news — only report movement on rows we had
        // already seen, or the first sweep would DM every open PR at once.
        const isFirstSighting = task.seen_comments === null
            || task.seen_comments === undefined;
        if (isFirstSighting) continue;
        if (!decisionChanged && newComments === 0) continue;

        changed.push({
            task: prTasks.get(task.id),
            decision,
            decisionBy,
            decisionChanged,
            newComments,
        });
    }

    return changed;
}

module.exports = {
    fetchPrState,
    fetchReviewDecision,
    fetchViewerLogin,
    fetchViewerTeams,
    mapCiState,
    refreshAll,
    refreshMine,
    reviewQueries,
    sweepMyPrs,
    sweepReviewRequests,
};
