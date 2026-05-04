/**
 * Build a tmux new-session command that runs the chosen CLI inside a login shell,
 * ensuring the full user environment (PATH, env vars, shell profiles) is loaded.
 *
 * @param {string} sessionName - tmux session name
 * @param {string} repoPath - working directory
 * @param {string} cliCmd - CLI command to run (e.g. `claude --dangerously-skip-permissions`
 *                         or `codex --dangerously-bypass-approvals-and-sandbox`)
 * @param {string} [sessionKey] - Slack session key (channelId-threadTs) passed as SLACK_SESSION_KEY env var
 * @param {string} [cliType] - 'claude' | 'codex'. Exported as CLI_SOURCE so the hook
 *                             script can branch on payload shape.
 */
function buildTmuxCommand(sessionName, repoPath, cliCmd, sessionKey, cliType) {
    const shell = process.env.SHELL || '/bin/zsh';
    const escapedCmd = cliCmd.replace(/'/g, "'\\''");
    const exports = [];
    if (sessionKey) exports.push(`export SLACK_SESSION_KEY='${sessionKey}'`);
    if (cliType) exports.push(`export CLI_SOURCE='${cliType}'`);
    // Strip OMC's notification credentials before launching the CLI. OMC's
    // Stop hook (installed in ~/.claude/settings.json by the user's interactive
    // setup) screen-scrapes the tmux pane via `tmux capture-pane` and posts
    // the tail to Slack with these tokens. Inside the bot, that double-posts
    // alongside our cli-hook-notify.js — and includes the input-box ghost
    // text Claude Code pre-fills as a "next action" suggestion. Our hook
    // already posts the canonical assistant message; OMC's notification path
    // adds noise. Unset so the spawned Claude (or its hooks) can't reach it.
    exports.push('unset OMC_SLACK_BOT_TOKEN OMC_SLACK_APP_TOKEN OMC_SLACK_CHANNEL_ID');
    const envExport = exports.length ? exports.join(' && ') + ' && ' : '';
    // Use -li (login + interactive) so .zshrc is sourced and the full user
    // environment (PATH, custom env vars) is available. Without -i, non-interactive
    // login shells skip .zshrc and tools like claude (in ~/.local/bin) aren't found.
    return `tmux new-session -d -s ${sessionName} -c "${repoPath}" "${shell} -li -c '${envExport}${escapedCmd}'"`;
}

module.exports = { buildTmuxCommand };
