// src/graph-context/config.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

class GraphContextConfig {
  constructor(cfg) {
    this.global = {
      enabled: cfg.enabled ?? false,
      budget_tokens: cfg.default_budget_tokens ?? 4000,
      depth: cfg.default_depth ?? 2,
      timeout_ms: cfg.timeout_ms ?? 2000,
    };
    this.channels = cfg.channels || {};
    this.denylist = new Set(cfg.denylist || []);
  }

  static load(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return new GraphContextConfig(yaml.load(raw) || {});
  }

  forChannel(channelId) {
    if (this.denylist.has(channelId)) return { enabled: false };
    const override = this.channels[channelId] || {};
    return { ...this.global, ...override };
  }
}

module.exports = { GraphContextConfig };
