// src/graph-context/index.js
'use strict';

const { GraphClient } = require('./client');
const { formatSystemBlock } = require('./inject');
const { handleCommand } = require('./commands');

async function buildContext(opts, clientOverride) {
  if (!opts || !opts.enabled) return '';
  if (!opts.seeds || opts.seeds.length === 0) return '';
  const client = clientOverride || new GraphClient({
    baseUrl: process.env.AGENT_MEM_GRAPH_URL,
    apiKey: process.env.AGENT_MEM_API_KEY,
    timeoutMs: opts.timeoutMs || 2000,
  });
  const resp = await client.resolve({
    seeds:           opts.seeds,
    query:           opts.query || '',
    asker_eeid:      opts.askerEEID || 0,
    depth:           opts.depth || 2,
    budget_tokens:   opts.budget_tokens || 4000,
    include_bodies:  true,
  });
  return formatSystemBlock(resp);
}

module.exports = { buildContext, handleCommand, GraphClient };
