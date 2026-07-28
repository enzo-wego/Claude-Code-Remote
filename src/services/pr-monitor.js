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

async function fetchPrState({ repo, number, token }) {
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
    const reviewState = requestedReviewers.length > 0
        ? 'requested'
        : pull.review_state === 'reviewed' || pull.reviewed === true
            ? 'reviewed'
            : 'none';

    return {
        ci: mapCiState(checks),
        reviewState,
        title: pull.title || null,
        author: pull.user?.login || null,
        requestedReviewers,
    };
}

async function fetchViewerLogin(token) {
    const viewer = await githubJson(`${GITHUB_API}/user`, token);
    if (!viewer.login) {
        throw new Error('GitHub /user response did not include login');
    }
    return viewer.login;
}

async function refreshAll(prTasks, token) {
    const readyBefore = new Set(
        prTasks.reviewReady().map(task => task.id)
    );

    for (const task of prTasks.listActive()) {
        const state = await fetchPrState({
            repo: task.repo,
            number: task.number,
            token,
        });
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
};
