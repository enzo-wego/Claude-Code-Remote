// src/graph-context/commands.js
'use strict';

const { GraphClient } = require('./client');

async function handleCommand({ text, channel, user }, client) {
  client = client || new GraphClient({
    baseUrl: process.env.AGENT_MEM_GRAPH_URL,
    apiKey:  process.env.AGENT_MEM_API_KEY,
  });
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  if (cmd === '/whygraph') {
    // arg can be a URL or a node_id
    const lookup = arg.startsWith('http')
      ? await client.node({ url: arg, asker: user })
      : await client.node({ id: arg, asker: user });
    if (!lookup) return `No node found for \`${arg}\`.`;
    return renderNodeWithEdges(lookup);
  }

  if (cmd === '/search') {
    if (!arg) return 'Usage: `/search <text>`';
    const res = await client.search({ q: arg, asker: user, limit: 5 });
    if (!res || !res.results) return 'Search returned no results.';
    return renderSearchResults(res.results);
  }

  return `Unknown command: ${cmd}`;
}

function renderNodeWithEdges(n) {
  const lines = [];
  lines.push(`*${n.title}* (${n.type})`);
  lines.push(`URL: ${n.url}`);
  if (n.summary) lines.push(`Summary: ${n.summary}`);
  lines.push(`*Edges in (${n.edges_in?.length ?? 0}):*`);
  for (const e of (n.edges_in || []).slice(0, 5)) {
    lines.push(`  - ${e.kind} ← \`${e.from}\``);
  }
  lines.push(`*Edges out (${n.edges_out?.length ?? 0}):*`);
  for (const e of (n.edges_out || []).slice(0, 5)) {
    lines.push(`  - ${e.kind} → \`${e.to}\``);
  }
  return lines.join('\n');
}

function renderSearchResults(results) {
  const lines = ['*Top results:*'];
  for (const r of results) {
    lines.push(`- *${r.title}* _(score ${r.score.toFixed(2)})_`);
    lines.push(`  ${r.url}`);
    if (r.summary) lines.push(`  > ${r.summary.split('\n')[0]}`);
  }
  return lines.join('\n');
}

module.exports = { handleCommand, renderNodeWithEdges, renderSearchResults };
