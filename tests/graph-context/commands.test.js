/**
 * T07: handleCommand unit tests for /whygraph and /search DM commands.
 */

const { handleCommand } = require('../../src/graph-context/commands');

describe('handleCommand', () => {
    test('/whygraph url returns rendered node', async () => {
        const fake = {
            node: async () => ({
                title: 'X', type: 'jira', url: 'http://x',
                summary: 'sum', edges_in: [{ kind: 'REFERENCES', from: 'slack:1' }], edges_out: [],
            }),
        };
        const out = await handleCommand({ text: '/whygraph http://x', user: 'U1' }, fake);
        expect(out).toMatch(/X/);
        expect(out).toMatch(/REFERENCES/);
    });

    test('/search renders top results', async () => {
        const fake = {
            search: async () => ({
                results: [
                    { title: 'T1', score: 0.9, url: 'http://1', summary: 'one liner' },
                ],
            }),
        };
        const out = await handleCommand({ text: '/search TripleA', user: 'U1' }, fake);
        expect(out).toMatch(/T1/);
    });

    test('unknown command returns hint', async () => {
        const out = await handleCommand({ text: '/foo', user: 'U1' }, {});
        expect(out).toMatch(/Unknown/);
    });
});
