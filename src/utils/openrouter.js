'use strict';

const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

// LLM_PROVIDER selects the backend: 'openrouter' (default; OPENROUTER_API_KEY,
// sk-or…) or 'google' (direct Gemini API; GOOGLE_API_KEY, AIza…). Flip the env +
// restart claude-remote to fail over when OpenRouter is out of quota. The public
// signature is unchanged so all call sites stay the same.
function activeProvider() {
    return process.env.LLM_PROVIDER === 'google' ? 'google' : 'openrouter';
}

/**
 * Chat completion returning text. Dispatches to OpenRouter or Google per
 * LLM_PROVIDER. `messages` is OpenAI-shaped; the Google branch translates it.
 * @param {Array<{role:string, content:any}>} messages
 * @param {{model?:string, maxTokens?:number}} [opts]
 * @returns {Promise<string>}
 */
async function openrouterComplete(messages, opts = {}) {
    if (activeProvider() === 'google') {
        return googleComplete(messages, opts);
    }
    return openrouterCompleteImpl(messages, opts);
}

// --- OpenRouter (OpenAI-compatible) ---
async function openrouterCompleteImpl(messages, { model = DEFAULT_MODEL, maxTokens = 1024 } = {}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

    const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            reasoning: { effort: 'low' },
        }),
    });

    if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
}

// --- Google Gemini (direct API) ---
async function googleComplete(messages, { model, maxTokens = 1024 } = {}) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

    // gemini-2.5-flash for both providers; strip any "google/" namespace prefix
    // that the OpenRouter default carries.
    const modelId = (model || process.env.GOOGLE_MODEL || DEFAULT_MODEL).replace(/^google\//, '');

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const gm = genAI.getGenerativeModel({ model: modelId, generationConfig: { maxOutputTokens: maxTokens } });

    const result = await gm.generateContent(messagesToGoogleParts(messages));
    return (result.response.text() || '').trim();
}

// messagesToGoogleParts flattens OpenAI-shaped messages into Gemini parts:
// string content → {text}; {type:'text'} → {text}; {type:'image_url'} data-URI →
// {inlineData:{mimeType,data}}. (All CCR call sites send role 'user'.)
function messagesToGoogleParts(messages) {
    const parts = [];
    for (const m of messages) {
        const c = m.content;
        if (typeof c === 'string') {
            parts.push({ text: c });
            continue;
        }
        if (Array.isArray(c)) {
            for (const p of c) {
                if (p.type === 'text' && p.text) {
                    parts.push({ text: p.text });
                } else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
                    const match = p.image_url.url.match(/^data:([^;]+);base64,([\s\S]*)$/);
                    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                }
            }
        }
    }
    return parts;
}

/**
 * Build a chat content part from a Slack file (OpenAI shape; the Google branch
 * translates it). Images → image_url data-URI; text/code/log → decoded text;
 * unsupported binary → null (caller skips).
 * @param {string} mimetype
 * @param {string} base64Data
 * @param {string} name
 */
function fileToContentPart(mimetype, base64Data, name) {
    if (mimetype && mimetype.startsWith('image/')) {
        return { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64Data}` } };
    }
    try {
        const text = Buffer.from(base64Data, 'base64').toString('utf-8');
        return { type: 'text', text: `File ${name} (${mimetype}):\n${text.slice(0, 20000)}` };
    } catch (_e) {
        return null;
    }
}

module.exports = { openrouterComplete, fileToContentPart, messagesToGoogleParts, DEFAULT_MODEL };
