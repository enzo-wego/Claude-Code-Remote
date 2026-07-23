// src/graph-context/client.js
'use strict';

class GraphClient {
  constructor({ baseUrl, apiKey, timeoutMs = 2000, logger }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.log = logger || console;
  }

  async resolve(payload) {
    return this._post('/api/graph/resolve', payload);
  }

  async search(params) {
    const url = new URL(this.baseUrl + '/api/graph/search');
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
      else if (v !== undefined) url.searchParams.set(k, v);
    });
    return this._get(url.toString(), params.asker);
  }

  async node({ url, id, asker }) {
    const u = new URL(this.baseUrl + '/api/graph/node');
    if (url) u.searchParams.set('url', url);
    if (id) u.searchParams.set('id', id);
    return this._get(u.toString(), asker);
  }

  // Resolve a single Slack user id to a profile
  // ({ slack_user_id, display_name, real_name, is_bot, email, department, eeid }).
  // Returns null on 404 / any error. See agent-mem GET /api/graph/slack-user.
  async slackUser(uid) {
    if (!uid) return null;
    const u = new URL(this.baseUrl + '/api/graph/slack-user');
    u.searchParams.set('id', uid);
    return this._get(u.toString());
  }

  async _post(path, body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.log.warn?.(`graph ${path} status ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      this.log.debug?.(`graph ${path} failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async _get(url, asker) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'Authorization': `Bearer ${this.apiKey}` };
      if (asker) headers['X-Asker-User'] = asker;
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      this.log.debug?.(`graph GET ${url} failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

module.exports = { GraphClient };
