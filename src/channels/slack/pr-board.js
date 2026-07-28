const CI_GLYPHS = {
    green: '🟢',
    red: '🔴',
    pending: '🟡',
    unknown: '⚪',
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

function buildPrBoardBlocks(prTasks = []) {
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

    if (prTasks.length === 0) {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '_No pull requests need your review._',
            },
        });
        return blocks;
    }

    for (const task of prTasks) {
        const glyph = CI_GLYPHS[task.ci] || CI_GLYPHS.unknown;
        const title = task.title || `${task.repo}#${task.number}`;
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: [
                    `${glyph} *<${task.url}|${title}>*`,
                    `\`${task.repo}#${task.number}\` · review: *${task.review_state || 'unknown'}* · status: *${task.status}*`,
                ].join('\n'),
            },
        });

        if (task.status === 'detected' || task.status === 'needs_review') {
            blocks.push({
                type: 'actions',
                elements: [
                    button(
                        'pr_review_now',
                        '🔍 Review now',
                        task.id,
                        'primary'
                    ),
                    button('pr_dismiss', '🙈 Dismiss', task.id),
                ],
            });
        } else if (task.status === 'reviewing') {
            blocks.push({
                type: 'context',
                elements: [{
                    type: 'mrkdwn',
                    text: '_reviewing on your Mac…_',
                }],
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

function buildPrDraftResultBlocks(task, jobRow) {
    const result = JSON.parse(jobRow.result_json || '{}');
    const title = task.title || `${task.repo}#${task.number}`;
    const preview = (result.body_md || '').slice(0, 2500);
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Apex review draft ready:* <${task.url}|${title}>\n_${result.summary || ''}_`,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '```' + preview + '```',
            },
        },
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

module.exports = { buildPrBoardBlocks, buildPrDraftResultBlocks };
