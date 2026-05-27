/**
 * T01: GraphClient unit tests — verifies POST /resolve with bearer auth,
 * and timeout returns null on a slow server.
 */

const http = require('node:http');
const { GraphClient } = require('../../src/graph-context/client');

describe('GraphClient', () => {
    test('resolve POSTs to /api/graph/resolve with bearer + payload', async () => {
        let got;
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                got = { url: req.url, method: req.method, auth: req.headers.authorization, body };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ artifacts: [], graph_trace: {} }));
            });
        });
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        const c = new GraphClient({ baseUrl: `http://localhost:${port}`, apiKey: 'TEST' });
        await c.resolve({ seeds: ['slack:C:1'], asker_eeid: 982, depth: 2, budget_tokens: 4000 });
        await new Promise(r => server.close(r));

        expect(got.url).toBe('/api/graph/resolve');
        expect(got.method).toBe('POST');
        expect(got.auth).toBe('Bearer TEST');
        const parsed = JSON.parse(got.body);
        expect(parsed.seeds).toEqual(['slack:C:1']);
    });

    test('resolve respects timeout and returns null on slow server', async () => {
        let delayTimer;
        const server = http.createServer((req, res) => {
            delayTimer = setTimeout(() => { res.end('{}'); }, 5000);
        });
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        const c = new GraphClient({
            baseUrl: `http://localhost:${port}`,
            apiKey: 'TEST',
            timeoutMs: 200,
        });
        const result = await c.resolve({ seeds: ['a'] });
        expect(result).toBeNull();
        clearTimeout(delayTimer);
        // Force-close any open connections before closing the server
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }, 10000);
});
