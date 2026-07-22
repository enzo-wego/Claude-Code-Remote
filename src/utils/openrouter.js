'use strict';

const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

/**
 * Call OpenRouter's OpenAI-compatible chat/completions and return the text.
 * reasoning.effort is kept low so this stays snappy for an interactive Slack bot.
 * @param {Array<{role:string, content:any}>} messages
 * @param {{model?:string, maxTokens?:number}} [opts]
 * @returns {Promise<string>}
 */
async function openrouterComplete(messages, { model = DEFAULT_MODEL, maxTokens = 1024 } = {}) {
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

/**
 * Build a chat content part from a Slack file. OpenRouter's OpenAI-shaped API
 * accepts images as image_url data-URIs; text/code/log files must be decoded to
 * text. Returns null for unsupported binary types (caller skips it).
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

module.exports = { openrouterComplete, fileToContentPart, DEFAULT_MODEL };
