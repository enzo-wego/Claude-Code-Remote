'use strict';

/**
 * T09: HTTP POST to agent-mem /api/graph/ingest/content with retry classification.
 *
 * RetryableError (5xx / network / timeout) -> buffer keeps the line for next drain cycle
 * FatalError (4xx) -> buffer skips the line (malformed for receiver)
 */

class RetryableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RetryableError';
        this.fatal = false;
    }
}

class FatalError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FatalError';
        this.fatal = true;
    }
}

/**
 * Post a payload to agent-mem.
 *
 * @param {Object} payload - The ingest payload
 * @param {Object} opts - Override URL/key for testing
 * @throws {RetryableError} on 5xx / network / timeout
 * @throws {FatalError} on 4xx
 */
async function post(payload, { url, apiKey } = {}) {
    const baseUrl = url || process.env.AGENT_MEM_GRAPH_URL;
    const key = apiKey || process.env.AGENT_MEM_API_KEY;

    if (!baseUrl) {
        throw new RetryableError('AGENT_MEM_GRAPH_URL not configured');
    }

    const endpoint = `${baseUrl}/api/graph/ingest/content`;

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key || ''}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(2000), // 2 s — buffer covers slower retries
        });
    } catch (err) {
        // Network error or timeout
        throw new RetryableError(`network/timeout: ${err.message}`);
    }

    if (res.status >= 500) {
        throw new RetryableError(`status ${res.status}`);
    }
    if (res.status >= 400) {
        throw new FatalError(`status ${res.status}`);
    }

    return res.json();
}

module.exports = { post, RetryableError, FatalError };
