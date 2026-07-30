function usedAgo(timestamp, now = Date.now()) {
    const elapsed = Math.max(0, now - Number(timestamp || now));
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

function processPayload(task, session = null) {
    return {
        repo: task.repo,
        pr: task.number,
        url: task.url,
        title: task.title,
        sessionKey: session ? session.key : null,
        cli: session ? session.cli : null,
        threads: null,
    };
}

function enqueueProcess(task, session, jobs) {
    return jobs.enqueue('address_comments', processPayload(task, session), {
        dedupeKey: `address_comments:${task.repo}#${task.number}`,
    });
}

function processReply(task, job) {
    return job
        ? `:gear: Processing #${task.number} on your Mac…`
        : `:information_source: Processing for #${task.number} is already queued.`;
}

/**
 * The runner resumes with `claude --resume <key>` and nothing else. Codex uses
 * `codex resume <id>`, so handing it a Codex key would launch Claude against an
 * id it has never seen, quietly start a fresh conversation, and then compact
 * that. Refuse where the reason can still be read, rather than opening a pane
 * that looks like it worked.
 */
function unresumableReason(session) {
    const cli = session && session.cli;
    if (!cli || cli === 'claude') return null;
    return `:warning: \`${session.label || session.key.slice(0, 8)}\` is a `
        + `${cli} session, and the runner only knows how to resume Claude. `
        + 'Record a Claude session for this PR, or process it by hand.';
}

async function handlePrAction({
    actionId,
    value,
    prTasks,
    jobs,
    agentSessions,
    // Free text from the Edit modal, used only by pr_revise.
    instructions = '',
}) {
    const [taskValue, selectedSessionValue] = actionId === 'pr_process_with'
        ? String(value).split(':')
        : [value, null];
    const task = prTasks.get(Number(taskValue));
    if (!task) return `:warning: PR task ${taskValue} not found.`;

    switch (actionId) {
        case 'pr_process': {
            const sessions = agentSessions
                ? agentSessions.sessionsFor(task.id)
                : [];
            if (sessions.length > 1) {
                return {
                    text: `Choose a session to process #${task.number}.`,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `Choose a session to process *${task.repo}#${task.number}*:`,
                            },
                        },
                        {
                            type: 'actions',
                            elements: sessions.map(session => {
                                const label = String(
                                    session.label || session.key.slice(0, 8)
                                ).slice(0, 55);
                                return {
                                    type: 'button',
                                    action_id: 'pr_process_with',
                                    text: {
                                        type: 'plain_text',
                                        text: `${label} · ${usedAgo(
                                            session.last_used_at
                                                || session.created_at
                                        )}`,
                                    },
                                    value: `${task.id}:${session.id}`,
                                };
                            }),
                        },
                    ],
                };
            }

            const session = sessions[0] || null;
            const refusal = unresumableReason(session);
            if (refusal) return refusal;
            const job = enqueueProcess(task, session, jobs);
            if (job && session) agentSessions.touch(session.id);
            return processReply(task, job);
        }

        case 'pr_process_with': {
            const sessionId = Number(selectedSessionValue);
            const session = agentSessions
                && agentSessions.sessionsFor(task.id)
                    .find(candidate => candidate.id === sessionId);
            if (!session) {
                return ':warning: That session is no longer available for '
                    + `${task.repo}#${task.number}.`;
            }
            const refusal = unresumableReason(session);
            if (refusal) return refusal;
            const job = enqueueProcess(task, session, jobs);
            if (job) agentSessions.touch(sessionId);
            return processReply(task, job);
        }

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
