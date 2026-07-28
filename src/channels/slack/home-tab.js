/**
 * App Home tab — the Entity's glanceable status board (small v0).
 * Pure renderer: state in, Block Kit home view out. Repainted on every
 * app_home_opened event. Grows agenda / night-plan / Mac-jobs / rules
 * sections as Plans B/D/E land.
 */
const { buildPrBoardBlocks } = require('./pr-board');

function fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function buildHomeView(state) {
    const now = state.now || Date.now();

    if (!state.isOwner) {
        return {
            type: 'home',
            blocks: [
                { type: 'header', text: { type: 'plain_text', text: '🧠 EnzoBot' } },
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: "EnzoBot is Enzo's personal agent. Mention <@EnzoBot> in a channel to chat with it." },
                },
            ],
        };
    }

    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🧠 EnzoBot — live status' } },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Repaints each time you open this tab' }],
        },
        ...buildPrBoardBlocks(state.prTasks || [], { refreshing: state.refreshing }),
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Service*  up ${fmtDuration(state.uptimeSec * 1000)} · Socket Mode connected` },
        },
    ];

    const sessions = state.sessions || [];
    const lines = sessions.slice(0, 10).map(s => {
        const repo = (s.repoPath || '').split('/').filter(Boolean).pop() || '?';
        const alive = s.alive ? ':large_green_circle:' : ':white_circle: dead';
        const age = s.updatedAt ? `· active ${fmtDuration(now - s.updatedAt)} ago` : '';
        return `${alive} \`${s.name}\` — ${s.cliType || 'claude'} · ${repo} ${age}`;
    });
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: `*Sessions*  ${sessions.filter(s => s.alive).length} live / ${sessions.length} tracked` +
                (lines.length ? '\n' + lines.join('\n') : '\n_none_'),
        },
    });

    if (state.queue) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Alert queue*  ${state.queue.pending} pending · ${state.queue.processing} processing` },
        });
    }

    if (state.schedules && state.schedules.dailySummaryTime) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Schedules*  daily summary ${state.schedules.dailySummaryTime}` },
        });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Coming soon: agenda · night plan · Mac jobs · rules  (Plans B/D/E)' }],
    });

    return { type: 'home', blocks };
}

module.exports = { buildHomeView };
