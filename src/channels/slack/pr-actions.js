async function handlePrAction({
    actionId,
    value,
    prTasks,
    jobs,
    // Free text from the Edit modal, used only by pr_revise.
    instructions = '',
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
            if (!result.pane_id) {
                return `:warning: No live review session for ${task.repo}#${task.number} — re-run the review.`;
            }
            // GitHub refuses to let you approve your own PR, so the `mine` lane
            // always files a comment however clean the verdict was.
            const approving = result.verdict === 'approve' && task.lane !== 'mine';
            const queued = jobs.enqueue('pane_message', {
                pane_id: result.pane_id,
                repo: task.repo,
                pr: task.number,
                text: approving
                    ? 'Post the review to GitHub now and submit it as an APPROVAL.'
                        + ' Place the inline comments yourself on the lines you verified;'
                        + ' anything you could not anchor goes in the review body.'
                    : 'Post the review to GitHub now as a COMMENT, not an approval.'
                        + ' Place the inline comments yourself on the lines you verified;'
                        + ' anything you could not anchor goes in the review body.',
            }, {
                dedupeKey: `post_review:${task.repo}#${task.number}`,
            });
            prTasks.setStatus(task.id, 'posted');
            if (!queued) {
                return `:information_source: Review for #${task.number} is already queued for posting.`;
            }
            return approving
                ? `:white_check_mark: Told the reviewer to approve #${task.number}…`
                : `:outbox_tray: Told the reviewer to post #${task.number}…`;
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

        // Revise-then-post: the reviewer keeps its own context, so it is told
        // what to change rather than handed a rewritten body to parrot.
        case 'pr_revise': {
            const draft = task.draft_job_id ? jobs.get(task.draft_job_id) : null;
            const result = draft && draft.result_json
                ? JSON.parse(draft.result_json)
                : {};
            if (!result.pane_id) {
                return `:warning: No live review session for ${task.repo}#${task.number} — re-run the review.`;
            }
            const queued = jobs.enqueue('pane_message', {
                pane_id: result.pane_id,
                repo: task.repo,
                pr: task.number,
                text: `${instructions}\n\nApply that, then post the revised review`
                    + ' to GitHub as a COMMENT, placing inline comments yourself.',
            }, {
                dedupeKey: `revise:${task.repo}#${task.number}:${Date.now()}`,
            });
            prTasks.setStatus(task.id, 'posted');
            return queued
                ? `:pencil2: Sent your changes to the reviewer for #${task.number}…`
                : `:information_source: Already queued for #${task.number}.`;
        }

        // Ends the review session and touches the PR in no way.
        case 'pr_discard': {
            const draft = task.draft_job_id ? jobs.get(task.draft_job_id) : null;
            const result = draft && draft.result_json
                ? JSON.parse(draft.result_json)
                : {};
            if (result.pane_id) {
                jobs.enqueue('pane_close', {
                    pane_id: result.pane_id,
                    repo: task.repo,
                    pr: task.number,
                }, {
                    dedupeKey: `pane_close:${result.pane_id}`,
                });
            }
            // Back to actionable rather than dismissed: nothing was posted, so
            // the PR should stay reviewable.
            prTasks.failDraft(task.id);
            return `:door: Closed the review session for ${task.repo}#${task.number}. Nothing was posted.`;
        }

        case 'pr_dismiss':
            prTasks.setStatus(task.id, 'dismissed');
            return `:wastebasket: Dismissed ${task.repo}#${task.number}.`;

        default:
            return `:warning: Unknown PR action ${actionId}.`;
    }
}

module.exports = { handlePrAction };
