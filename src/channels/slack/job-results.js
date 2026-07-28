/**
 * Job results → owner DM. Slack mrkdwn only. Suggest-only boundary lives
 * here: posting to GitHub happens ONLY via job_post_review, which is only
 * reachable from the owner's button tap, and executes on the Mac with the
 * owner's own gh auth.
 */
function buildReviewResultBlocks(jobRow) {
    const payload = JSON.parse(jobRow.payload_json);
    const result = JSON.parse(jobRow.result_json || '{}');
    const title = `${payload.repo}#${payload.pr}`;
    const preview = (result.body_md || '').slice(0, 2500);
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Review draft ready:* <${payload.url || '#'}|${title}>\n_${result.summary || ''}_`,
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
                {
                    type: 'button',
                    action_id: 'job_post_review',
                    style: 'primary',
                    text: { type: 'plain_text', text: '📤 Post review' },
                    value: String(jobRow.id),
                },
                {
                    type: 'button',
                    action_id: 'job_discard',
                    text: { type: 'plain_text', text: '🗑 Discard' },
                    value: String(jobRow.id),
                },
            ],
        },
    ];
}

async function handleJobAction({ actionId, value, jobs }) {
    const job = jobs.get(Number(value));
    if (!job) return `:warning: Job ${value} not found.`;
    const payload = JSON.parse(job.payload_json);
    const result = JSON.parse(job.result_json || '{}');

    switch (actionId) {
        case 'job_post_review': {
            const queued = jobs.enqueue('post_review', {
                repo: payload.repo,
                pr: payload.pr,
                body_md: result.body_md || '',
            }, {
                dedupeKey: `post_review:${payload.repo}#${payload.pr}`,
            });
            return queued
                ? ':outbox_tray: Post queued — it publishes from your Mac (as you) within ~10s of the lid being open.'
                : `:warning: A post for ${payload.repo}#${payload.pr} is already queued.`;
        }
        case 'job_discard':
            return `:wastebasket: Discarded — the draft stays in the job log if you change your mind (job ${job.id}).`;
        default:
            return `:warning: Unknown action ${actionId}.`;
    }
}

module.exports = { buildReviewResultBlocks, handleJobAction };
