/**
 * T04: GraphContextConfig loader tests.
 */

const path = require('node:path');
const { GraphContextConfig } = require('../../src/graph-context/config');

describe('GraphContextConfig', () => {
    test('loads and applies channel overrides', () => {
        const cfg = GraphContextConfig.load(path.join(__dirname, '../../config/graph-context.yaml'));
        const incidents = cfg.forChannel('C08S954G2LX');
        expect(incidents.budget_tokens).toBe(6000);
        const random = cfg.forChannel('C_RANDOM');
        expect(random.budget_tokens).toBe(4000);
    });

    test('denylist disables a channel', () => {
        const cfg = GraphContextConfig.load(path.join(__dirname, '../../config/graph-context.yaml'));
        const denied = cfg.forChannel('C_GENERAL_NOISE_CHANNEL');
        expect(denied.enabled).toBe(false);
    });
});
