// src/graph-context/inject.js
'use strict';

function formatSystemBlock(resolveResponse) {
  if (!resolveResponse || !resolveResponse.artifacts || resolveResponse.artifacts.length === 0) {
    return '';
  }
  const lines = [];
  lines.push('## Related context from the graph');
  lines.push('');
  lines.push('The following artefacts were surfaced by graph traversal from the current thread.');
  lines.push('Cite by node_id when referencing them in your reply.');
  lines.push('');
  for (const a of resolveResponse.artifacts) {
    const author = a.author?.name ? ` — _${a.author.name}_` : '';
    const score = a.score != null ? ` _(score ${a.score.toFixed(2)}, hop ${a.hop ?? 0})_` : '';
    lines.push(`### [${a.type}] ${a.title || a.node_id}${author}${score}`);
    lines.push(`URL: ${a.url}`);
    lines.push(`node_id: \`${a.node_id}\``);
    lines.push('');
    if (a.body) {
      lines.push(truncate(a.body, 4000));
      lines.push('');
    } else if (a.summary) {
      lines.push(a.summary);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  if (resolveResponse.cache_misses && resolveResponse.cache_misses.length > 0) {
    lines.push(`> Note: ${resolveResponse.cache_misses.length} additional artefact(s) are being fetched in the background and will be available on the next reply.`);
    lines.push('');
  }
  return lines.join('\n');
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 12) + '\n…[truncated]';
}

module.exports = { formatSystemBlock, truncate };
