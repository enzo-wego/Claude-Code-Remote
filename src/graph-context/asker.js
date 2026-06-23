// src/graph-context/asker.js
'use strict';

const { GraphClient } = require('./client');

class AskerLookup {
  constructor({ client, ttlMs = 5 * 60 * 1000 }) {
    this.client = client || new GraphClient({
      baseUrl: process.env.AGENT_MEM_GRAPH_URL,
      apiKey:  process.env.AGENT_MEM_API_KEY,
    });
    this.ttlMs = ttlMs;
    this.cache = new Map(); // slackUid → { eeid, at }
  }

  async eeidForSlackUid(uid) {
    if (!uid) return 0;
    const cached = this.cache.get(uid);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.eeid;
    const node = await this.client.node({ id: `person:slack:${uid}`, asker: uid });
    const eeid = node?.eeid || 0;
    this.cache.set(uid, { eeid, at: Date.now() });
    return eeid;
  }
}

module.exports = { AskerLookup };
