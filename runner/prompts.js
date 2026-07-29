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

function buildApexReviewPrompt(payload, resultPath) {
    return [
        `Review pull request ${payload.repo}#${payload.pr} (${payload.url}).`,
        'Run the /apex-review skill on it. It reviews in an isolated worktree and never posts.',
        "From apex-review's findings, keep only must-fix + high-confidence items.",
        `Write the final review as GitHub-flavored markdown to: ${resultPath}`,
        '(verdict line, then ## Blocking / ## Suggestions / ## Nits — omit empty sections).',
        `Write a one-line summary (counts) to ${resultPath}.summary.`,
        // A real GitHub approval must not hinge on grepping "LGTM" out of prose.
        `Write exactly one word to ${resultPath}.verdict — "approve" if there are`,
        'zero blocking findings, otherwise "comment". No punctuation, no explanation.',
        'Then print RESULT_READY.',
        'Do NOT post anything to GitHub. Draft only.',
    ].join('\n');
}

module.exports = { buildReviewPrompt, buildApexReviewPrompt };
