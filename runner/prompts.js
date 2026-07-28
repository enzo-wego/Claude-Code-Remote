/**
 * Prompt builders for Mac runner jobs. The prompt is the contract with the
 * Claude Code TUI running in the herdr pane: isolate in a worktree, never
 * touch the user's working tree, never post to GitHub, write the result to
 * a file and print RESULT_READY as the final line.
 */
function buildReviewPrompt(payload, resultPath, checkoutPath) {
    return [
        `Review pull request ${payload.repo}#${payload.pr} (${payload.url || ''}).`,
        '',
        'Rules (non-negotiable):',
        `- Work read-only with respect to my checkout at ${checkoutPath}: create a`,
        `  git worktree (git -C ${checkoutPath} worktree add <tmpdir> FETCH_HEAD after`,
        '  fetching the PR head) and review inside it; remove the worktree when done.',
        '- Do NOT post anything to GitHub. No gh pr review, no comments. Draft only.',
        '- Do NOT modify my working tree, branches, or any remote.',
        '',
        'Review focus: correctness bugs first, then security, then tests, then style.',
        'Read the full diff AND enough surrounding code to judge correctness.',
        '',
        `Write the finished review as GitHub-flavored markdown to: ${resultPath}`,
        'Format: one-line verdict, then ## Blocking, ## Suggestions, ## Nits sections',
        '(omit empty sections). Then write a one-line summary (counts per section) to',
        `${resultPath}.summary. When both files are written, print exactly:`,
        'RESULT_READY',
    ].join('\n');
}

module.exports = { buildReviewPrompt };
