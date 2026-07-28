const CI_GLYPHS = {
    green: '🟢',
    red: '🔴',
    pending: '🟡',
    unknown: '⚪',
};

const DECISION_GLYPHS = {
    approved: '✅',
    changes_requested: '🛑',
    commented: '💬',
};

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

function ciGlyph(task) {
    return CI_GLYPHS[task.ci] || CI_GLYPHS.unknown;
}

function titleOf(task) {
    return task.title || `${task.repo}#${task.number}`;
}

function section(text) {
    return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** Rows where someone is waiting on you. */
function reviewLaneBlocks(tasks) {
    const blocks = [];
    for (const task of tasks) {
        blocks.push(section([
            `${ciGlyph(task)} *<${task.url}|${titleOf(task)}>*`,
            `\`${task.repo}#${task.number}\` · review: *${task.review_state || 'unknown'}* · status: *${task.status}*`,
        ].join('\n')));

        if (task.status === 'detected' || task.status === 'needs_review') {
            blocks.push({
                type: 'actions',
                elements: [
                    button('pr_review_now', '🔍 Review now', task.id, 'primary'),
                    button('pr_dismiss', '🙈 Dismiss', task.id),
                ],
            });
        } else if (task.status === 'reviewing') {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: '_reviewing on your Mac…_' }],
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

        blocks.push({ type: 'divider' });
    }
    return blocks;
}

/**
 * Rows where you are waiting on everyone else. The lead glyph is the review
 * decision when there is one, because "did a teammate reply" is the question
 * this lane exists to answer; CI moves into the meta line.
 */
function mineLaneBlocks(tasks) {
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'My PRs' } },
    ];

    if (tasks.length === 0) {
        blocks.push(section('_No open PRs of yours._'));
        return blocks;
    }

    for (const task of tasks) {
        const glyph = DECISION_GLYPHS[task.review_decision] || ciGlyph(task);
        const who = task.decision_by ? ` by *@${task.decision_by}*` : '';
        // ponytail: total count, not an unread delta — the delta is what the DM
        // carries. Storing an unread watermark per view is the upgrade if the
        // total turns out to be useless at a glance.
        const verdict = {
            approved: `approved${who}`,
            changes_requested: `changes requested${who}`,
            commented: `commented on${who}`,
        }[task.review_decision] || 'no review yet';

        blocks.push(section([
            `${glyph} *<${task.url}|${titleOf(task)}>*`,
            `\`${task.repo}#${task.number}\` · ${verdict} · CI: ${ciGlyph(task)}`
                + (task.seen_comments ? ` · 💬 ${task.seen_comments}` : ''),
        ].join('\n')));

        const elements = [linkButton('🔗 Open', task.url)];
        if (task.review_decision === 'approved' && task.ci === 'green') {
            elements.unshift({
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
            });
        }
        blocks.push({ type: 'actions', elements });
        blocks.push({ type: 'divider' });
    }

    return blocks;
}

function buildPrBoardBlocks(prTasks = []) {
    const review = prTasks.filter(task => (task.lane || 'review') === 'review');
    const mine = prTasks.filter(task => task.lane === 'mine');

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: 'PR Review Board' },
        },
        {
            // Re-sweeps GitHub on the spot rather than waiting for the next
            // monitor cycle, then repaints. value is unused but Slack wants one.
            type: 'actions',
            elements: [
                button('pr_refresh', '🔄 Refresh now', 'refresh'),
            ],
        },
    ];

    if (review.length === 0) {
        blocks.push(section('_No pull requests need your review._'));
    } else {
        blocks.push(...reviewLaneBlocks(review));
    }

    blocks.push(...mineLaneBlocks(mine));

    return blocks;
}

function buildPrDraftResultBlocks(task, jobRow) {
    const result = JSON.parse(jobRow.result_json || '{}');
    const preview = (result.body_md || '').slice(0, 2500);
    return [
        section(
            `*Apex review draft ready:* <${task.url}|${titleOf(task)}>\n_${result.summary || ''}_`
        ),
        section('```' + preview + '```'),
        {
            type: 'actions',
            elements: [
                button('pr_post', '📤 Post', task.id, 'primary'),
                button('pr_edit', '✏️ Edit', task.id),
                button('pr_discard', '🗑 Discard', task.id, 'danger'),
            ],
        },
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
    buildMineChangeText,
    buildPrBoardBlocks,
    buildPrDraftResultBlocks,
};
