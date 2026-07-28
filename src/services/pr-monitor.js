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

async function fetchPrState({ repo, number, token, viewerLogin }) {
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
    // GitHub drops you from requested_reviewers once you submit a review, so
    // presence there is the signal. Scope it to the owner when we know who
    // that is — another reviewer still being pending is not our business.
    // (`pull.review_state` / `pull.reviewed` do not exist on this payload.)
    const stillRequested = viewerLogin
        ? requestedReviewers.includes(viewerLogin)
        : requestedReviewers.length > 0;

    return {
        ci: mapCiState(checks),
        reviewState: stillRequested ? 'requested' : 'none',
        title: pull.title || null,
        author: pull.user?.login || null,
        requestedReviewers,
        // A PR that left GitHub's queue should leave the board too.
        closed: pull.state === 'closed',
        merged: Boolean(pull.merged_at),
    };
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
async function sweepReviewRequests(prTasks, token) {
    const query = 'is:pr is:open review-requested:@me archived:false draft:false';
    const data = await githubJson(
        `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=50`,
        token
    );
    const seeded = [];
    for (const item of data.items || []) {
        const match = String(item.html_url || '')
            .match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!match) continue;
        seeded.push(prTasks.upsert({
            repo: match[1],
            number: Number(match[2]),
            url: item.html_url,
            title: item.title || null,
            author: item.user?.login || null,
            reviewState: 'requested',
            origin: 'github-sweep',
        }));
    }
    return seeded;
}

async function refreshAll(prTasks, token, viewerLogin) {
    const readyBefore = new Set(
        prTasks.reviewReady().map(task => task.id)
    );

    for (const task of prTasks.listActive()) {
        const state = await fetchPrState({
            repo: task.repo,
            number: task.number,
            token,
            viewerLogin,
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
        });
    }

    return prTasks.reviewReady()
        .filter(task => !readyBefore.has(task.id));
}

module.exports = {
    fetchPrState,
    fetchViewerLogin,
    mapCiState,
    refreshAll,
    sweepReviewRequests,
};
