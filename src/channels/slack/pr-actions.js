async function handlePrAction({
    actionId,
    value,
    prTasks,
    jobs,
}) {
    const task = prTasks.get(Number(value));
    if (!task) return `:warning: PR task ${value} not found.`;

    switch (actionId) {
        case 'pr_review_now': {
            const job = jobs.enqueue('apex_review', {
                repo: task.repo,
                pr: task.number,
                url: task.url,
                // Carries the Jira key, which becomes the herdr tab name.
                title: task.title,
            }, {
                dedupeKey: `apex_review:${task.repo}#${task.number}`,
            });
            if (!job) {
                return `:information_source: Review for #${task.number} is already queued.`;
            }
            prTasks.setDraftJob(task.id, job.id);
            return `:mag: Reviewing #${task.number} on your Mac…`;
        }

        case 'pr_post': {
            const draft = task.draft_job_id
                ? jobs.get(task.draft_job_id)
                : null;
            if (!draft || !draft.result_json) {
                return `:warning: Draft for ${task.repo}#${task.number} is not available.`;
            }
            const result = JSON.parse(draft.result_json);
            // GitHub refuses to let you approve your own PR, so the `mine` lane
            // always files a comment however clean the verdict was.
            const approving = result.verdict === 'approve' && task.lane !== 'mine';
            const queued = jobs.enqueue('post_review', {
                repo: task.repo,
                pr: task.number,
                body_md: result.body_md || '',
                method: approving ? 'approve' : 'comment',
            }, {
                dedupeKey: `post_review:${task.repo}#${task.number}`,
            });
            prTasks.setStatus(task.id, 'posted');
            if (!queued) {
                return `:information_source: Review for #${task.number} is already queued for posting.`;
            }
            return approving
                ? `:white_check_mark: Approving #${task.number} from your Mac…`
                : `:outbox_tray: Review for #${task.number} queued for posting from your Mac.`;
        }

        case 'pr_merge': {
            // Merged from the Mac like every other write, so it runs under a
            // token that actually has push rights — the VPS token may not.
            const queued = jobs.enqueue('merge_pr', {
                repo: task.repo,
                pr: task.number,
            }, {
                dedupeKey: `merge_pr:${task.repo}#${task.number}`,
            });
            return queued
                ? `:rocket: Merging ${task.repo}#${task.number} from your Mac…`
                : `:information_source: ${task.repo}#${task.number} is already queued to merge.`;
        }

        case 'pr_edit':
            return ':pencil2: Reply here with the changes you want, then tap Post.';

        case 'pr_discard':
        case 'pr_dismiss':
            prTasks.setStatus(task.id, 'dismissed');
            return `:wastebasket: Dismissed ${task.repo}#${task.number}.`;

        default:
            return `:warning: Unknown PR action ${actionId}.`;
    }
}

module.exports = { handlePrAction };
