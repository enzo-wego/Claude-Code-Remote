'use strict';

/**
 * Tests for src/graph-ingest/handler.js
 * Covers T14 (edit), T15 (delete), T16 (files), T17 (bot author).
 */

const { buildPayload, buildCanonicalUrl } = require('../../src/graph-ingest/handler');
const { loadConfig, _resetConfig } = require('../../src/graph-ingest/config-loader');

// Simple stub cache
function makeCache(users = {}, channels = {}) {
    const cache = {
        users: new Map(Object.entries(users)),
        channels: new Map(Object.entries(channels)),
        getUser(id) { return this.users.get(id)?.display_name || id; },
        getChannel(id) { return this.channels.get(id)?.name || id; },
        getUserMeta(id) { return this.users.get(id) || null; },
    };
    return cache;
}

const BASE_EVENT = {
    channel: 'C05RNSE8TBR',
    user: 'U_HUMAN',
    text: 'hello world',
    ts: '1779711855.864859',
};

describe('buildCanonicalUrl', () => {
    test('builds permalink from channel + ts', () => {
        const url = buildCanonicalUrl('C05RNSE8TBR', '1779711855.864859', 'wego');
        expect(url).toBe('https://wego.slack.com/archives/C05RNSE8TBR/p1779711855864859');
    });

    test('removes dot from ts', () => {
        const url = buildCanonicalUrl('CABC', '123.456', 'wego');
        expect(url).toContain('p123456');
    });
});

describe('buildPayload: normal message', () => {
    test('source is slack', () => {
        const p = buildPayload(BASE_EVENT, 'hello world', [], [], null, makeCache());
        expect(p.source).toBe('slack');
    });

    test('author ref uses slack_uid prefix', () => {
        const cache = makeCache({ U_HUMAN: { display_name: 'Joe', is_bot: false } });
        const p = buildPayload(BASE_EVENT, 'hi', [], [], null, cache);
        expect(p.metadata.author.ref).toBe('slack_uid:U_HUMAN');
        expect(p.metadata.author.display_name).toBe('Joe');
        expect(p.metadata.author.is_bot).toBe(false);
    });

    test('scope is slack:<channel_id>', () => {
        const p = buildPayload(BASE_EVENT, 'hi', [], [], null, makeCache());
        expect(p.metadata.scope).toBe('slack:C05RNSE8TBR');
    });

    test('thread_ts is included when present', () => {
        const event = { ...BASE_EVENT, thread_ts: '111.111' };
        const p = buildPayload(event, 'hi', [], [], null, makeCache());
        expect(p.metadata.thread_ts).toBe('111.111');
    });

    test('thread_ts is null when absent', () => {
        const p = buildPayload(BASE_EVENT, 'hi', [], [], null, makeCache());
        expect(p.metadata.thread_ts).toBeNull();
    });
});

describe('T14: buildPayload for message_changed', () => {
    test('uses event.message.text for body via normalize (edit flag set)', () => {
        const event = {
            channel: 'C05RNSE8TBR',
            subtype: 'message_changed',
            message: { text: 'updated body', ts: '1779711855.864859', user: 'U_HUMAN', thread_ts: null },
            ts: '1779711855.864859',
        };
        const filterMeta = { subtype: 'message_changed', edited: true, body_ts: '222.222' };
        const p = buildPayload(event, 'updated body', [], [], filterMeta, makeCache());
        expect(p.body).toBe('updated body');
        expect(p.metadata.edited).toBe(true);
        expect(p.metadata.subtype).toBe('message_changed');
    });
});

describe('T15: buildPayload for message_deleted', () => {
    test('body is empty string, deleted flag set', () => {
        const event = {
            channel: 'C05RNSE8TBR',
            subtype: 'message_deleted',
            deleted_ts: '111.111',
            ts: '111.111',
        };
        const filterMeta = { subtype: 'message_deleted', deleted: true };
        const p = buildPayload(event, '', [], [], filterMeta, makeCache());
        expect(p.body).toBe('');
        expect(p.metadata.deleted).toBe(true);
        expect(p.metadata.subtype).toBe('message_deleted');
    });
});

describe('T16: files in payload metadata', () => {
    test('files array is included in metadata', () => {
        const event = {
            ...BASE_EVENT,
            files: [
                {
                    id: 'F0B5TLXQLTV',
                    mimetype: 'image/png',
                    name: 'screenshot.png',
                    size: 248312,
                    url_private: 'https://files.slack.com/private',
                    thumb_360: 'https://files.slack.com/thumb',
                },
            ],
        };
        const p = buildPayload(event, 'see screenshot', [], [], null, makeCache());
        expect(p.metadata.files).toHaveLength(1);
        expect(p.metadata.files[0]).toMatchObject({
            id: 'F0B5TLXQLTV',
            mimetype: 'image/png',
            filename: 'screenshot.png',
            size: 248312,
        });
    });

    test('no files → empty array', () => {
        const p = buildPayload(BASE_EVENT, 'text', [], [], null, makeCache());
        expect(p.metadata.files).toEqual([]);
    });
});

describe('T17: bot author handling', () => {
    test('bot_id → ref="bot:<username>"', () => {
        const event = {
            channel: 'C05RNSE8TBR',
            bot_id: 'B123',
            username: 'AirflowBot',
            text: 'DAG succeeded',
            ts: '999.999',
        };
        const p = buildPayload(event, 'DAG succeeded', [], [], null, makeCache());
        expect(p.metadata.author.ref).toBe('bot:AirflowBot');
        expect(p.metadata.author.display_name).toBe('AirflowBot');
        expect(p.metadata.author.is_bot).toBe(true);
    });

    test('bot without username falls back to bot_id', () => {
        const event = {
            channel: 'C05RNSE8TBR',
            bot_id: 'B456',
            text: 'alert fired',
            ts: '888.888',
        };
        const p = buildPayload(event, 'alert fired', [], [], null, makeCache());
        expect(p.metadata.author.ref).toBe('bot:B456');
        expect(p.metadata.author.display_name).toBe('B456');
        expect(p.metadata.author.is_bot).toBe(true);
    });

    test('human user from cache gets correct ref and display_name', () => {
        const cache = makeCache({ U_HUMAN: { display_name: 'Jane Doe', is_bot: false, email: 'jane@example.com' } });
        const p = buildPayload(BASE_EVENT, 'hi', [], [], null, cache);
        expect(p.metadata.author.ref).toBe('slack_uid:U_HUMAN');
        expect(p.metadata.author.display_name).toBe('Jane Doe');
        expect(p.metadata.author.is_bot).toBe(false);
    });
});
