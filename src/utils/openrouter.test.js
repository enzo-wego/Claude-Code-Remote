const { openrouterComplete, fileToContentPart, messagesToGoogleParts } = require('./openrouter');

// Mock the Google SDK so the google-provider path can be exercised without a key.
const mockGenerateContent = jest.fn(async () => ({ response: { text: () => '  g-out  ' } }));
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({
        getGenerativeModel: jest.fn(() => ({ generateContent: mockGenerateContent })),
    })),
}));

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

describe('messagesToGoogleParts (OpenAI → Gemini translation)', () => {
    test('string content → text part', () => {
        expect(messagesToGoogleParts([{ role: 'user', content: 'hi' }])).toEqual([{ text: 'hi' }]);
    });

    test('text part + image_url data-URI → text + inlineData', () => {
        const parts = messagesToGoogleParts([{
            role: 'user',
            content: [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
            ],
        }]);
        expect(parts).toEqual([
            { text: 'describe this' },
            { inlineData: { mimeType: 'image/png', data: 'AAAB' } },
        ]);
    });
});

describe('openrouterComplete with LLM_PROVIDER=google', () => {
    const OLD = { provider: process.env.LLM_PROVIDER, key: process.env.GOOGLE_API_KEY };
    beforeEach(() => { process.env.LLM_PROVIDER = 'google'; mockGenerateContent.mockClear(); });
    afterEach(() => {
        process.env.LLM_PROVIDER = OLD.provider;
        process.env.GOOGLE_API_KEY = OLD.key;
    });

    test('routes to Google (no fetch), returns trimmed text', async () => {
        process.env.GOOGLE_API_KEY = 'AIza-test';
        const out = await openrouterComplete([{ role: 'user', content: 'x' }]);
        expect(out).toBe('g-out');
        expect(mockGenerateContent).toHaveBeenCalledWith([{ text: 'x' }]);
    });

    test('throws a clear error when GOOGLE_API_KEY is missing', async () => {
        delete process.env.GOOGLE_API_KEY;
        await expect(openrouterComplete([{ role: 'user', content: 'x' }])).rejects.toThrow('GOOGLE_API_KEY');
    });
});
