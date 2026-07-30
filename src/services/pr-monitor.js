const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = `${GITHUB_API}/graphql`;
const REVIEW_THREADS_QUERY = `
    query($owner:String!, $name:String!, $number:Int!) {
        repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
                reviewThreads(first:100) {
                    nodes {
                        isResolved
                        isOutdated
                        path
                        line
                        comments(last:1) {
                            nodes {
                                author { login }
                                createdAt
                            }
                        }
                    }
                }
            }
        }
    }
`;

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

/**
 * Review threads are GraphQL-only: REST review comments do not expose whether
 * their thread is resolved. Failure is reported as null so a caller never
 * mistakes "could not tell" for "no open threads".
 */
async function fetchReviewThreads({ repo, number, token }) {
    try {
        const [owner, name, extra] = String(repo || '').split('/');
        if (!owner || !name || extra) {
            throw new Error(`invalid GitHub repo '${repo}'`);
        }

        const response = await fetch(GITHUB_GRAPHQL, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: REVIEW_THREADS_QUERY,
                variables: { owner, name, number: Number(number) },
            }),
        });
        if (!response.ok) {
            throw new Error(`GitHub GraphQL ${response.status}`);
        }

        const payload = await response.json();
        if (Array.isArray(payload?.errors) && payload.errors.length) {
            const messages = payload.errors
                .map(error => error?.message)
                .filter(Boolean)
                .join('; ');
            throw new Error(`GitHub GraphQL errors: ${messages || 'unknown'}`);
        }

        const nodes = payload?.data?.repository?.pullRequest
            ?.reviewThreads?.nodes;
        if (!Array.isArray(nodes)) {
            throw new Error('GitHub GraphQL response had no review thread list');
        }
        if (nodes.length === 100) {
            console.warn(
                `${repo}#${number} returned 100 review threads; `
                + 'the first page may be truncated'
            );
        }
        return nodes;
    } catch (err) {
        console.warn(
            `Review thread fetch failed for ${repo}#${number}: ${err.message}`
        );
        return null;
    }
}

/** Threads that are live and whose last readable author was not the viewer. */
function countOpenThreads(nodes, viewerLogin) {
    if (!Array.isArray(nodes)) return 0;
    const viewer = String(viewerLogin || '').toLowerCase();

    return nodes.reduce((count, node) => {
        if (node?.isResolved || node?.isOutdated) return count;
        const comments = node?.comments?.nodes;
        if (!Array.isArray(comments) || comments.length === 0) {
            return count + 1;
        }
        const author = comments[comments.length - 1]?.author?.login;
        if (!author) return count + 1;
        return String(author).toLowerCase() === viewer ? count : count + 1;
    }, 0);
}

/**
 * Logins on a team, e.g. 'wego/payments-geeks'.
 *
 * This is how "is this PR from my team?" gets answered. GitHub search cannot
 * filter by email or team, and a shared repo like wego-docs carries PRs from
 * every team — so authorship against the team roster is the only exact signal.
 */
async function fetchTeamMembers(token, team) {
    const [org, slug] = String(team || '').split('/');
    if (!org || !slug) throw new Error(`team must be 'org/slug', got '${team}'`);
    const members = await githubJson(
        `${GITHUB_API}/orgs/${org}/teams/${slug}/members?per_page=100`,
        token
    );
    return (Array.isArray(members) ? members : [])
        .map(member => member.login)
        .filter(Boolean);
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

/**
 * Run `worker` over `items` with a bounded number in flight.
 *
 * The detail passes are the slow part of a cycle — one PR at a time meant a
 * manual Refresh took 25s on 13 PRs, most of it waiting on round trips. Five at
 * a time cuts that to a few seconds and stays far inside the rate limit.
 */
async function mapLimit(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
            await worker(queue.shift());
        }
    });
    await Promise.all(runners);
}

const DETAIL_CONCURRENCY = 5;

/** GitHub ISO timestamp → epoch ms, or null. */
function epoch(iso) {
    const ms = Date.parse(iso || '');
    return Number.isFinite(ms) ? ms : null;
}

function parsePrUrl(htmlUrl) {
    const match = String(htmlUrl || '')
        .match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/**
 * One page of search results, plus how many were left behind.
 *
 * 100 is the API maximum. A wide query genuinely exceeds it (all open PRs
 * across six wego repos is 162), so truncation is reported rather than
 * swallowed — a board that quietly drops PRs is worse than one that says it
 * did. Callers log `dropped`; keep queries narrow enough that it stays 0.
 */
async function searchPrs(qualifier, token) {
    const query = `is:pr is:open archived:false ${qualifier}`;
    const data = await githubJson(
        `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
        token
    );
    const items = data.items || [];
    return {
        items,
        dropped: Math.max(0, Number(data.total_count || 0) - items.length),
    };
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
        createdAt: epoch(pull.created_at),
        // A PR that left GitHub's queue should leave the board too.
        closed: pull.state === 'closed',
        merged: Boolean(pull.merged_at),
    };
}

/**
 * Review bots (CodeRabbit, the Codex connector, …) comment on essentially every
 * PR, so counting them as reviewers makes "someone replied" fire constantly and
 * mean nothing. They are excluded everywhere: the question this lane answers is
 * whether a *person* has weighed in.
 */
function isBot(user) {
    if (!user) return false;
    return user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');
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
        if (isBot(review.user)) continue;
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

/**
 * Comments written by actual people, excluding your own.
 *
 * The `comments` / `review_comments` totals on the pull payload are free but
 * count bots, and on these repos bots outnumber humans roughly 10:1 — a
 * watermark built on them would fire on every CodeRabbit pass. Two extra calls
 * buys a signal that means what it says.
 */
/**
 * Every human utterance on a PR, oldest first: issue comments, inline review
 * comments and review submissions, merged into one timeline.
 *
 * Bots are excluded throughout — CodeRabbit comments on everything, and a
 * timeline it dominates answers no question worth asking.
 */
async function fetchActivity({ repo, number, token, viewerLogin }) {
    const [issueComments, reviewComments, reviews] = await Promise.all([
        githubJson(`${GITHUB_API}/repos/${repo}/issues/${number}/comments?per_page=100`, token),
        githubJson(`${GITHUB_API}/repos/${repo}/pulls/${number}/comments?per_page=100`, token),
        githubJson(`${GITHUB_API}/repos/${repo}/pulls/${number}/reviews?per_page=100`, token),
    ]);

    const events = [];
    const add = (rows, stamp) => {
        for (const row of Array.isArray(rows) ? rows : []) {
            const who = row.user?.login;
            if (!who || isBot(row.user)) continue;
            events.push({ who, at: row[stamp] || '' });
        }
    };
    add(issueComments, 'created_at');
    add(reviewComments, 'created_at');
    add(reviews, 'submitted_at');
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

    return {
        // Who spoke last decides whose turn it is.
        lastSpeaker: events.length ? events[events.length - 1].who : null,
        // Comments by someone other than you — the "did a teammate reply"
        // watermark, which must not count your own words.
        othersComments: events.filter(e => !viewerLogin || e.who !== viewerLogin).length,
    };
}

/**
 * Whose move it is.
 *
 * The board exists to answer "does this need me", and that is decided by who
 * spoke last, not by CI or by how the PR looks. If the author spoke last the
 * ball is with the reviewers; if a reviewer spoke last it is back with the
 * author. A PR nobody has said anything on is waiting for its first review.
 *
 * Returns 'done' | 'mine' | 'theirs'.
 */
function turnFor({
    decision,
    author,
    lastSpeaker,
    viewerLogin,
    openThreads = 0,
}) {
    if (Number(openThreads) > 0) return 'mine';
    if (decision === 'approved') return 'done';
    const ballWithAuthor = Boolean(lastSpeaker) && lastSpeaker !== author;
    const viewerIsAuthor = Boolean(viewerLogin) && viewerLogin === author;
    return ballWithAuthor === viewerIsAuthor ? 'mine' : 'theirs';
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
async function sweepReviewRequests(prTasks, token, {
    teams = [],
    viewerLogin,
    org = '',
} = {}) {
    const seeded = [];
    const seen = new Set();
    const scope = org ? `org:${org} ` : '';

    for (const qualifier of reviewQueries(teams)) {
        // One team's query failing (deleted team, missing scope) must not cost
        // us the other queries' results.
        let items;
        try {
            ({ items } = await searchPrs(`${scope}${qualifier} draft:false`, token));
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
                prCreatedAt: epoch(item.created_at),
                isDraft: Boolean(item.draft),
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
async function sweepMyPrs(prTasks, token, { org = '' } = {}) {
    const scope = org ? `org:${org} ` : '';
    const { items } = await searchPrs(`${scope}author:@me`, token);
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
            prCreatedAt: epoch(item.created_at),
            isDraft: Boolean(item.draft),
        }));
    }
    return seeded;
}

/**
 * Open PRs written by your teammates, anywhere in the org.
 *
 * Deliberately author-scoped rather than repo-scoped. A repo allowlist has both
 * failure modes at once: it floods the board with other teams' work in shared
 * repos (wego-docs, and 84 open PRs across pennyworth/roxana/olympias with none
 * from this team), and it silently misses repos nobody remembered to list —
 * payments-knowledge, wego-fares and yorktown-admin-proxy all turned up here
 * without being named. `author:` OR-combines, so one query covers the org.
 *
 * Returns { seeded, dropped } so a truncated page is reported, not hidden.
 */
async function sweepTeamPrs(prTasks, token, { members = [], viewerLogin, org = '' } = {}) {
    const others = members.filter(login => login && login !== viewerLogin);
    if (others.length === 0) return { seeded: [], dropped: 0 };

    const scope = org ? `org:${org} ` : '';
    const authors = others.map(login => `author:${login}`).join(' ');
    const { items, dropped } = await searchPrs(`${scope}${authors}`, token);

    const seeded = [];
    for (const item of items) {
        const pull = parsePrUrl(item.html_url);
        if (!pull) continue;
        seeded.push(prTasks.upsert({
            ...pull,
            url: item.html_url,
            title: item.title || null,
            author: item.user?.login || null,
            origin: 'github-team',
            lane: 'team',
            prCreatedAt: epoch(item.created_at),
            isDraft: Boolean(item.draft),
        }));
    }
    return { seeded, dropped };
}

/**
 * Refresh the two "waiting on a review" lanes. Team rows get the same CI and
 * retirement treatment as review rows; only the review lane can become
 * reviewReady(), so auto-review never fires on a teammate's PR unasked.
 */
async function refreshAll(prTasks, token, viewerLogin, viewerTeams = []) {
    const readyBefore = new Set(
        prTasks.reviewReady().map(task => task.id)
    );

    for (const lane of ['review', 'team']) {
        await mapLimit(prTasks.listActive(lane), DETAIL_CONCURRENCY, async task => {
            const [state, threadNodes] = await Promise.all([
                fetchPrState({
                    repo: task.repo,
                    number: task.number,
                    token,
                    viewerLogin,
                    viewerTeams,
                }),
                fetchReviewThreads({
                    repo: task.repo,
                    number: task.number,
                    token,
                }),
            ]);
            if (state.closed) {
                // Merged or closed on GitHub — the review is moot, so retire
                // the card instead of leaving stale work on the board.
                prTasks.setStatus(task.id, 'closed');
                return;
            }
            const openThreads = threadNodes === null
                ? null
                : countOpenThreads(threadNodes, viewerLogin);
            prTasks.setOpenThreads(task.id, openThreads);
            prTasks.upsert({
                repo: task.repo,
                number: task.number,
                url: task.url,
                title: state.title,
                author: state.author,
                ci: state.ci,
                reviewState: state.reviewState,
                origin: task.origin,
                lane,
                prCreatedAt: state.createdAt,
                isDraft: state.draft,
            });

            // "Already approved" is the single most useful thing to know about
            // a teammate's PR — it is the row you can skip. No viewerLogin here:
            // unlike your own PRs, a review *you* left still counts, and seeing
            // it is the point ("I already signed off on this one").
            // Non-fatal: the decision is a decoration on the row. Losing it must
            // not take the whole sweep down with it (mapLimit rejects on first
            // throw), so keep whatever we recorded last time.
            try {
                const [{ decision, decisionBy }, activity] = await Promise.all([
                    fetchReviewDecision({
                        repo: task.repo,
                        number: task.number,
                        token,
                    }),
                    fetchActivity({ repo: task.repo, number: task.number, token }),
                ]);
                prTasks.setDecision(task.id, {
                    reviewDecision: decision,
                    decisionBy,
                });
                // Whose move it is — the only thing the row's glyph now shows.
                prTasks.setTurn(task.id, turnFor({
                    decision,
                    author: state.author,
                    lastSpeaker: activity.lastSpeaker,
                    viewerLogin,
                    openThreads,
                }));
            } catch (err) {
                // Keep the previous decision, but say so — a swallowed failure
                // here looks exactly like "nobody has reviewed it".
                console.warn(
                    `PR decision fetch failed for ${task.repo}#${task.number}: ${err.message}`
                );
            }
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

    await mapLimit(prTasks.listActive('mine'), DETAIL_CONCURRENCY, async task => {
        const [state, threadNodes] = await Promise.all([
            fetchPrState({
                repo: task.repo,
                number: task.number,
                token,
                viewerLogin,
            }),
            fetchReviewThreads({
                repo: task.repo,
                number: task.number,
                token,
            }),
        ]);
        if (state.closed) {
            prTasks.setStatus(task.id, 'closed');
            return;
        }
        const openThreads = threadNodes === null
            ? null
            : countOpenThreads(threadNodes, viewerLogin);
        prTasks.setOpenThreads(task.id, openThreads);

        const [{ decision, decisionBy }, activity] = await Promise.all([
            fetchReviewDecision({
                repo: task.repo,
                number: task.number,
                token,
                viewerLogin,
            }),
            fetchActivity({
                repo: task.repo,
                number: task.number,
                token,
                viewerLogin,
            }),
        ]);
        const humanComments = activity.othersComments;

        prTasks.upsert({
            repo: task.repo,
            number: task.number,
            url: task.url,
            title: state.title,
            author: state.author,
            ci: state.ci,
            origin: task.origin,
            lane: 'mine',
            prCreatedAt: state.createdAt,
            isDraft: state.draft,
        });
        prTasks.setTurn(task.id, turnFor({
            decision,
            author: state.author,
            lastSpeaker: activity.lastSpeaker,
            viewerLogin,
            openThreads,
        }));

        const newComments = Math.max(0, humanComments - (task.seen_comments || 0));
        const decisionChanged = (decision || null) !== (task.review_decision || null);

        prTasks.setMineState(task.id, {
            reviewDecision: decision,
            decisionBy,
            seenComments: humanComments,
        });

        // A first sighting is not news — only report movement on rows we had
        // already seen, or the first sweep would DM every open PR at once.
        const isFirstSighting = task.seen_comments === null
            || task.seen_comments === undefined;
        if (isFirstSighting) return;
        if (!decisionChanged && newComments === 0) return;

        changed.push({
            task: prTasks.get(task.id),
            decision,
            decisionBy,
            decisionChanged,
            newComments,
        });
    });

    return changed;
}

module.exports = {
    mapLimit,
    countOpenThreads,
    fetchActivity,
    fetchReviewThreads,
    turnFor,
    fetchPrState,
    fetchReviewDecision,
    fetchTeamMembers,
    fetchViewerLogin,
    fetchViewerTeams,
    mapCiState,
    refreshAll,
    refreshMine,
    reviewQueries,
    sweepMyPrs,
    sweepReviewRequests,
    sweepTeamPrs,
};
