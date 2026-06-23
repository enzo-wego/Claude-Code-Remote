/**
 * T09: Integration test against a real agent-mem instance.
 * Skipped unless RUN_INTEGRATION=1 is set.
 */

const { GraphClient } = require('../../src/graph-context');

describe('GraphClient integration', () => {
    test('resolve real seed returns artifacts', async () => {
        if (!process.env.RUN_INTEGRATION) {
            return; // skip
        }
        const c = new GraphClient({
            baseUrl: process.env.AGENT_MEM_GRAPH_URL || 'http://localhost:34567',
            apiKey: process.env.AGENT_MEM_API_KEY,
            timeoutMs: 5000,
        });
        const resp = await c.resolve({
            seeds: ['jira:PAY-2128'],
            query: 'TRY currency',
            asker_eeid: 982,
            depth: 2,
            budget_tokens: 4000,
            include_bodies: true,
        });
        expect(resp).toBeTruthy();
        expect(resp.artifacts.length).toBeGreaterThan(0);
    });
});
