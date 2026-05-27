'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let _config = null;

function loadConfig() {
    if (_config) return _config;
    const configPath = path.join(__dirname, '../../config/graph-ingest.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    _config = yaml.load(raw);
    return _config;
}

// Reset for testing
function _resetConfig() {
    _config = null;
}

module.exports = { loadConfig, _resetConfig };
