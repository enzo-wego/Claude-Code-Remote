/**
 * Three states, one question: whose move is it?
 *
 * The board used to lead with CI and review-decision glyphs — seven symbols
 * describing the *state* of a PR, when the only thing being asked is whether it
 * needs you. Who spoke last answers that; CI does not.
 */
const TURN_GLYPHS = {
    mine: '🟡',    // waiting on you
    theirs: '💬',  // waiting on the other side
    done: '✅',    // approved, nothing owed
};

const DECISION_GLYPHS = {
    approved: '✅',
    changes_requested: '🛑',
    commented: '💬',
};

// Block Kit has no table element, and true column alignment exists only inside
// a code block — which strips links and cannot hold buttons. So a "table" here
// means: one line per PR, monospace repo#number so the left edge lines up, an
// age column, and the action on the right as a section accessory.
const TITLE_MAX = 62;

function button(actionId, text, taskId, style) {
    const element = {
        type: 'button',
        action_id: actionId,
        text: { type: 'plain_text', text },
        value: String(taskId),
    };
    if (style) element.style = style;
    return element;
}

function linkButton(text, url) {
    return {
        type: 'button',
        action_id: 'pr_open',
        text: { type: 'plain_text', text },
        url,
    };
}

/**
 * A section takes exactly one accessory, so a row that needs several actions
 * puts them in an overflow menu — keeping the row to a single block. Option
 * values carry the action id so one handler can dispatch them all.
 */
function overflow(taskId, entries) {
    return {
        type: 'overflow',
        action_id: 'pr_menu',
        options: entries.map(entry => {
            const option = {
                text: { type: 'plain_text', text: entry.text },
                value: `${entry.actionId}:${taskId}`,
            };
            if (entry.url) option.url = entry.url;
            return option;
        }),
    };
}

/** Fall back to 'mine' when a row predates the turn column — better to be
 *  asked about a PR that does not need you than to hide one that does. */
function turnOf(task) {
    return TURN_GLYPHS[task.turn] ? task.turn : 'mine';
}

function turnGlyph(task) {
    return TURN_GLYPHS[turnOf(task)];
}

function turnLabel(task) {
    const turn = turnOf(task);
    if (turn === 'done') {
        return `approved${task.decision_by ? ` @${task.decision_by}` : ''}`;
    }
    if (turn === 'mine') return 'your move';
    // "Waiting on them" means different people either side: on your own PR the
    // reviewers owe you a reply; on a teammate's, the author does.
    return task.lane === 'mine'
        ? 'waiting on reviewers'
        : `waiting on @${task.author || 'the author'}`;
}

/** Rows that need you, first; then oldest, since age is the next best signal. */
function byTurnThenAge(tasks) {
    const rank = { mine: 0, theirs: 1, done: 2 };
    return [...tasks].sort((a, b) =>
        (rank[turnOf(a)] - rank[turnOf(b)])
        || ((a.pr_created_at || 0) - (b.pr_created_at || 0)));
}

function truncate(text, max = TITLE_MAX) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function titleOf(task) {
    return task.title || `${task.repo}#${task.number}`;
}

/** Compact age since the PR was opened on GitHub: 4h, 3d, 5w. */
function ageOf(task, now = Date.now()) {
    if (!task.pr_created_at) return '';
    const hours = Math.floor((now - task.pr_created_at) / 3_600_000);
    if (hours < 1) return 'new';
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
}

function section(text, accessory) {
    const block = { type: 'section', text: { type: 'mrkdwn', text } };
    if (accessory) block.accessory = accessory;
    return block;
}

/** One table row: glyph · repo#n · title · trailing columns. */
function row(task, { glyph, columns = [], accessory }) {
    const age = ageOf(task);
    const cells = [...columns, age].filter(Boolean);
    return section(
        `${glyph} \`${task.repo}#${task.number}\`  *<${task.url}|${truncate(titleOf(task))}>*`
            + (cells.length ? `  ·  ${cells.join('  ·  ')}` : ''),
        accessory
    );
}

function header(text) {
    return { type: 'header', text: { type: 'plain_text', text } };
}

/**
 * A teammate's PR. Nobody has asked you for anything, so there is no nudge and
 * no auto-review — just visibility, and the option to pull one in yourself.
 * Oldest first: a PR nobody has touched for three weeks is the one worth seeing.
 */
function teamLaneBlocks(tasks) {
    const blocks = [header('Team PRs')];
    if (tasks.length === 0) {
        blocks.push(section('_No open PRs from your team._'));
        return blocks;
    }

    // Your turn first, then oldest. Sorting purely by age buried the one row
    // that actually needed you under a fortnight of other people's waiting.
    for (const task of byTurnThenAge(tasks)) {
        blocks.push(row(task, {
            glyph: turnGlyph(task),
            columns: [
                `@${task.author || 'unknown'}`,
                turnLabel(task),
            ],
            accessory: overflow(task.id, [
                { actionId: 'pr_review_now', text: '🔍 Review now' },
                { actionId: 'pr_dismiss', text: '🙈 Dismiss' },
                { actionId: 'pr_open', text: '🔗 Open on GitHub', url: task.url },
            ]),
        }));
    }
    return blocks;
}

/** Rows where someone is waiting on you. */
function reviewLaneBlocks(tasks) {
    const blocks = [];
    for (const task of tasks) {
        const actionable = task.status === 'detected'
            || task.status === 'needs_review';
        blocks.push(row(task, {
            glyph: turnGlyph(task),
            columns: [
                turnLabel(task),
                task.status === 'reviewing' ? '_reviewing on your Mac…_' : '',
            ],
            accessory: actionable
                ? button('pr_review_now', '🔍 Review now', task.id, 'primary')
                : undefined,
        }));

        if (actionable) {
            blocks.push({
                type: 'actions',
                elements: [button('pr_dismiss', '🙈 Dismiss', task.id)],
            });
        } else if (task.status === 'drafted') {
            blocks.push({
                type: 'actions',
                elements: [
                    button('pr_post', '📤 Post', task.id, 'primary'),
                    button('pr_edit', '✏️ Edit', task.id),
                    button('pr_discard', '🗑 Discard', task.id, 'danger'),
                ],
            });
        }
    }
    return blocks;
}

/**
 * Rows where you are waiting on everyone else. The lead glyph is the review
 * decision when there is one, because "did a teammate reply" is the question
 * this lane exists to answer; CI moves into a column.
 */
function mineLaneBlocks(tasks) {
    const blocks = [header('My PRs')];
    if (tasks.length === 0) {
        blocks.push(section('_No open PRs of yours._'));
        return blocks;
    }

    for (const task of byTurnThenAge(tasks)) {
        const mergeable = task.review_decision === 'approved'
            && task.ci === 'green';

        blocks.push(row(task, {
            glyph: turnGlyph(task),
            columns: [
                turnLabel(task),
                task.decision_by ? `@${task.decision_by}` : '',
            ],
            accessory: mergeable
                ? {
                    ...button('pr_merge', '🚀 Merge', task.id, 'primary'),
                    confirm: {
                        title: { type: 'plain_text', text: 'Merge this PR?' },
                        text: {
                            type: 'mrkdwn',
                            text: `*${task.repo}#${task.number}*\n${titleOf(task)}`,
                        },
                        confirm: { type: 'plain_text', text: 'Merge' },
                        deny: { type: 'plain_text', text: 'Cancel' },
                        style: 'primary',
                    },
                }
                : linkButton('🔗 Open', task.url),
        }));
    }
    return blocks;
}

function buildPrBoardBlocks(prTasks = []) {
    const review = prTasks.filter(task => (task.lane || 'review') === 'review');
    const mine = prTasks.filter(task => task.lane === 'mine');
    const team = prTasks.filter(task => task.lane === 'team');

    // Every lane gets its own header. Without one, the review lane's empty
    // state read as a caption on the page title instead of as a section.
    // Needs-my-review stays first: it is the only lane where someone is blocked
    // on you. Team PRs sit above your own, the least urgent thing here.
    const blocks = [header('Needs my review')];
    if (review.length === 0) {
        blocks.push(section('_Nothing is waiting on you._'));
    } else {
        blocks.push(...reviewLaneBlocks(review));
    }

    blocks.push({ type: 'divider' });
    blocks.push(...teamLaneBlocks(team));
    blocks.push({ type: 'divider' });
    blocks.push(...mineLaneBlocks(mine));

    return blocks;
}

// Slack rejects a section whose text exceeds 3000 characters.
const SLACK_TEXT_MAX = 2900;

/**
 * Split a long report across section blocks.
 *
 * Breaks on blank lines, and never inside a ``` fence — a fence split across
 * two blocks renders as literal backticks in both, which is how the stage
 * table would have arrived as a wall of pipes.
 */
function chunkForSlack(text, max = SLACK_TEXT_MAX) {
    const paragraphs = String(text || '').trim().split(/\n{2,}/);
    const chunks = [];
    let current = '';
    let insideFence = false;

    for (const paragraph of paragraphs) {
        const joined = current ? `${current}\n\n${paragraph}` : paragraph;
        if (joined.length > max && current && !insideFence) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = joined;
        }
        if ((paragraph.match(/```/g) || []).length % 2 === 1) {
            insideFence = !insideFence;
        }
    }
    if (current.trim()) chunks.push(current);

    // A single paragraph over the cap still has to break somewhere; lines are
    // the least bad seam. A fence that spans the seam is closed on the way out
    // and reopened on the way in, so neither half renders as loose backticks —
    // which matters because the stage table is exactly that shape.
    return chunks.flatMap(chunk => {
        if (chunk.length <= max) return [chunk];

        const out = [];
        let buffer = [];
        let fenced = false;

        const flush = () => {
            if (!buffer.length) return;
            out.push((fenced ? [...buffer, '```'] : buffer).join('\n'));
            buffer = fenced ? ['```'] : [];
        };

        for (const line of chunk.split('\n')) {
            const projected = buffer.join('\n').length + line.length + 5;
            if (buffer.length && projected > max) flush();
            buffer.push(line);
            if (line.trim().startsWith('```')) fenced = !fenced;
        }
        if (buffer.join('\n').trim() !== '```') flush();
        return out;
    });
}

function buildPrDraftResultBlocks(task, jobRow) {
    const result = JSON.parse(jobRow.result_json || '{}');
    const preview = (result.body_md || '').slice(0, 2500);

    // A clean verdict turns Post into Approve — but never on your own PR, which
    // GitHub would reject anyway. The verdict is a word the skill writes to a
    // file, not something grepped out of the review prose.
    const approving = result.verdict === 'approve' && task.lane !== 'mine';
    const post = approving
        ? {
            ...button('pr_post', '✅ Approve', task.id, 'primary'),
            confirm: {
                title: { type: 'plain_text', text: 'Approve this PR?' },
                text: {
                    type: 'mrkdwn',
                    text: `This files a *GitHub approval* on *${task.repo}#${task.number}*`
                        + ` in your name, and counts toward its merge requirements.`,
                },
                confirm: { type: 'plain_text', text: 'Approve' },
                deny: { type: 'plain_text', text: 'Cancel' },
                style: 'primary',
            },
        }
        : button('pr_post', '📤 Post', task.id, 'primary');

    const actions = {
        type: 'actions',
        elements: [
            post,
            button('pr_edit', '✏️ Edit', task.id),
            // Ends the reviewer's session; the PR is left untouched.
            button('pr_discard', '🚪 Exit', task.id, 'danger'),
        ],
    };

    // The reviewer's own report when there is one. It carries the reasoning and
    // the recommendation, which a truncated dump of the GitHub body never did —
    // that body is written for the PR author, not for the person deciding.
    if (result.report) {
        return [
            header(`Apex Review — ${task.repo}#${task.number}`),
            ...chunkForSlack(result.report).map(chunk => section(chunk)),
            {
                type: 'context',
                elements: [{
                    type: 'mrkdwn',
                    text: `verdict *${result.verdict || 'comment'}*`
                        + ' · reviewer still live — Post sends it back to that session'
                        + (result.pane_id ? ` (\`${result.pane_id}\`)` : ''),
                }],
            },
            actions,
        ];
    }

    return [
        section(
            `*Apex review draft ready:* <${task.url}|${titleOf(task)}>\n_${result.summary || ''}_`
        ),
        section('```' + preview + '```'),
        actions,
    ];
}

/** DM body for "a teammate moved on one of your PRs". */
function buildMineChangeText({ task, decision, decisionBy, decisionChanged, newComments }) {
    const glyph = DECISION_GLYPHS[decision] || '💬';
    const who = decisionBy ? `@${decisionBy}` : 'Someone';
    const head = decisionChanged && decision
        ? {
            approved: `${glyph} ${who} approved`,
            changes_requested: `${glyph} ${who} requested changes on`,
            commented: `${glyph} ${who} commented on`,
        }[decision]
        : `💬 ${newComments} new comment${newComments === 1 ? '' : 's'} on`;

    return `${head} *<${task.url}|${task.repo}#${task.number}>*\n${titleOf(task)}`;
}

module.exports = {
    ageOf,
    buildMineChangeText,
    buildPrBoardBlocks,
    buildPrDraftResultBlocks,
};
