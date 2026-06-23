/**
 * T02: formatSystemBlock unit tests.
 */

const { formatSystemBlock } = require('../../src/graph-context/inject');

describe('formatSystemBlock', () => {
    test('renders artifacts as Markdown with citations', () => {
        const resolveResponse = {
            context_tokens: 1234,
            artifacts: [
                {
                    node_id: 'slack:C08S954G2LX:1778119437.328319',
                    url: 'https://wego.slack.com/archives/C08S954G2LX/p1778119437328319',
                    type: 'slack_thread',
                    title: 'TRY currency incident',
                    author: 'PagerDuty',
                    score: 0.95,
                    body: 'Incident summary...',
                    hop: 0,
                },
                {
                    node_id: 'jira:PAY-2128',
                    url: 'https://wegomushi.atlassian.net/browse/PAY-2128',
                    type: 'jira',
                    title: 'Tabby installments_count',
                    author: 'Lei Zheng',
                    score: 0.81,
                    body: 'Root cause...',
                    hop: 1,
                },
            ],
            graph_trace: { expanded_nodes: 12, took_ms: 187 },
        };
        const block = formatSystemBlock(resolveResponse);

        expect(block).toMatch(/## Related context from the graph/);
        expect(block).toMatch(/\[slack_thread\] TRY currency incident/);
        expect(block).toMatch(/\[jira\] Tabby installments_count/);
        expect(block).toMatch(/Lei Zheng/);
        expect(block).toMatch(/PAY-2128/);
    });

    test('returns empty string on null or empty input', () => {
        expect(formatSystemBlock(null)).toBe('');
        expect(formatSystemBlock({ artifacts: [] })).toBe('');
    });
});
