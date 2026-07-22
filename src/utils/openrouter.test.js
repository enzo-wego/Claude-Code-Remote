const { openrouterComplete, fileToContentPart } = require('./openrouter');

describe('openrouterComplete', () => {
    const OLD_KEY = process.env.OPENROUTER_API_KEY;
    afterEach(() => { process.env.OPENROUTER_API_KEY = OLD_KEY; });

    test('posts to OpenRouter with bearer auth and returns trimmed content', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        let captured;
        global.fetch = jest.fn(async (url, opts) => {
            captured = { url, opts };
            return { ok: true, json: async () => ({ choices: [{ message: { content: '  hi  ' } }] }) };
        });

        const out = await openrouterComplete(
            [{ role: 'user', content: 'x' }],
            { model: 'google/gemini-2.5-flash' }
        );

        expect(out).toBe('hi');
        expect(captured.url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(captured.opts.headers.Authorization).toBe('Bearer test-key');
        const body = JSON.parse(captured.opts.body);
        expect(body.model).toBe('google/gemini-2.5-flash');
        expect(body.messages).toEqual([{ role: 'user', content: 'x' }]);
    });

    test('throws a clear error when the key is missing', async () => {
        delete process.env.OPENROUTER_API_KEY;
        await expect(openrouterComplete([{ role: 'user', content: 'x' }])).rejects.toThrow('OPENROUTER_API_KEY');
    });

    test('throws on non-ok HTTP status', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
        await expect(openrouterComplete([{ role: 'user', content: 'x' }])).rejects.toThrow('OpenRouter 401');
    });
});

describe('fileToContentPart', () => {
    test('image → image_url data URI', () => {
        const p = fileToContentPart('image/png', 'AAAA', 'a.png');
        expect(p.type).toBe('image_url');
        expect(p.image_url.url).toBe('data:image/png;base64,AAAA');
    });

    test('text/code file → decoded text part', () => {
        const b64 = Buffer.from('hello code').toString('base64');
        const p = fileToContentPart('text/plain', b64, 'a.txt');
        expect(p.type).toBe('text');
        expect(p.text).toContain('hello code');
        expect(p.text).toContain('a.txt');
    });
});
