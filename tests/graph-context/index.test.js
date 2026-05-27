/**
 * T03: buildContext public surface tests.
 */

const { buildContext } = require('../../src/graph-context');

describe('buildContext', () => {
    test('returns empty string when feature flag off', async () => {
        const out = await buildContext({
            enabled: false,
            seeds: ['slack:C:1'],
            asker: 'U07UAC0J7T3',
        }, { resolve: async () => ({ artifacts: [{ node_id: 'x' }] }) });
        expect(out).toBe('');
    });

    test('returns formatted block when feature flag on', async () => {
        const fakeClient = {
            resolve: async () => ({
                artifacts: [{
                    node_id: 'jira:PAY-1', type: 'jira', title: 'X',
                    url: 'http://x', author: { name: 'Lei' }, score: 0.9, body: 'body',
                }],
            }),
        };
        const out = await buildContext({
            enabled: true,
            seeds: ['slack:C:1'],
            asker: 'U07UAC0J7T3',
            budget_tokens: 4000,
        }, fakeClient);
        expect(out).toMatch(/Related context/);
        expect(out).toMatch(/PAY-1/);
    });

    test('returns empty on client failure', async () => {
        const fakeClient = { resolve: async () => null };
        const out = await buildContext({
            enabled: true,
            seeds: ['slack:C:1'],
            asker: 'U07UAC0J7T3',
        }, fakeClient);
        expect(out).toBe('');
    });
});
