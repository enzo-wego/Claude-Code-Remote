'use strict';

/**
 * T04+T05: Tests for src/graph-ingest/normalizer.js
 */

const { normalize, stripSlackFormatting } = require('../../src/graph-ingest/normalizer');

// Simple stub cache
function makeCache(users = {}, channels = {}) {
    return {
        getUser: (id) => users[id] || id,
        getChannel: (id) => channels[id] || id,
    };
}

describe('normalizer: Slack markup → plain text', () => {

    test('plain text passthrough', async () => {
        const cache = makeCache();
        const { body, mentions, links } = await normalize({ text: 'hello world' }, cache);
        expect(body).toBe('hello world');
        expect(mentions).toEqual([]);
        expect(links).toEqual([]);
    });

    test('user mention <@U123> → @DisplayName', async () => {
        const cache = makeCache({ U123: 'Alice' });
        const { body, mentions } = await normalize({ text: 'hi <@U123>' }, cache);
        expect(body).toBe('hi @Alice');
        expect(mentions).toEqual([{ ref: 'slack_uid:U123', display_name: 'Alice' }]);
    });

    test('user mention fallback to raw ID when not in cache', async () => {
        const cache = makeCache();
        const { body, mentions } = await normalize({ text: 'hey <@UUNKNOWN>' }, cache);
        expect(body).toBe('hey @UUNKNOWN');
        expect(mentions[0].ref).toBe('slack_uid:UUNKNOWN');
    });

    test('channel mention <#C123|payments-eng> → #payments-eng', async () => {
        const cache = makeCache();
        const { body } = await normalize({ text: 'post in <#CUV9EAYGY|payments-eng>' }, cache);
        expect(body).toBe('post in #payments-eng');
    });

    test('channel mention <#C123> without label falls back to cache/id', async () => {
        const cache = makeCache({}, { C123: 'general' });
        const { body } = await normalize({ text: 'check <#C123>' }, cache);
        expect(body).toBe('check #general');
    });

    test('subteam mention <!subteam^S01|@payments-team> → @payments-team', async () => {
        const cache = makeCache();
        const { body, mentions } = await normalize({ text: 'ping <!subteam^S01|@payments-team>' }, cache);
        expect(body).toBe('ping @payments-team');
        expect(mentions[0].ref).toBe('slack_group:S01');
        expect(mentions[0].display_name).toBe('payments-team');
    });

    test('subteam mention without label uses id', async () => {
        const { body, mentions } = await normalize({ text: '<!subteam^S99>' }, makeCache());
        expect(body).toBe('@S99');
        expect(mentions[0].ref).toBe('slack_group:S99');
    });

    test('broadcasts: <!here> <!channel> <!everyone>', async () => {
        const { body } = await normalize({ text: '<!here> <!channel> <!everyone>' }, makeCache());
        expect(body).toBe('@here @channel @everyone');
    });

    test('bare URL <https://example.com> → https://example.com', async () => {
        const { body, links } = await normalize({ text: 'see <https://example.com>' }, makeCache());
        expect(body).toBe('see https://example.com');
        expect(links[0]).toEqual({ url: 'https://example.com', display_text: 'https://example.com' });
    });

    test('URL with label <https://example.com|click here> → click here (https://example.com)', async () => {
        const { body, links } = await normalize({ text: 'see <https://example.com|click here>' }, makeCache());
        expect(body).toBe('see click here (https://example.com)');
        expect(links[0]).toEqual({ url: 'https://example.com', display_text: 'click here' });
    });

    test('URL with | in label uses last pipe as separator', async () => {
        // e.g. <https://example.com/path|foo|bar> — last pipe separates:
        // url = "https://example.com/path|foo", label = "bar"
        // This matches agent-mem/internal/graph/normalizer/slack.go: lastPipe := strings.LastIndex(inner, "|")
        const { body } = await normalize({ text: '<https://example.com/path|foo|bar>' }, makeCache());
        expect(body).toBe('bar (https://example.com/path|foo)');
    });

    test('HTML entities &amp; &lt; &gt; are unescaped', async () => {
        const { body } = await normalize({ text: 'a &amp; b &lt;c&gt;' }, makeCache());
        expect(body).toBe('a & b <c>');
    });

    test('*bold* → bold', async () => {
        const { body } = await normalize({ text: 'this is *bold* text' }, makeCache());
        expect(body).toBe('this is bold text');
    });

    test('~strike~ → strike', async () => {
        const { body } = await normalize({ text: 'this is ~strikethrough~' }, makeCache());
        expect(body).toBe('this is strikethrough');
    });

    test('real-world: TRY thread message with mention and Jira link', async () => {
        const cache = makeCache({ U02FKR154T1: 'Alexandre Morin', UUK3WPNNQ: 'Lei Zheng' });
        const text = '<@U02FKR154T1> TRY split needed — see <https://jira.wego.com/browse/PAY-123|PAY-123>';
        const { body, mentions, links } = await normalize({ text }, cache);
        expect(body).toBe('@Alexandre Morin TRY split needed — see PAY-123 (https://jira.wego.com/browse/PAY-123)');
        expect(mentions).toHaveLength(1);
        expect(mentions[0]).toEqual({ ref: 'slack_uid:U02FKR154T1', display_name: 'Alexandre Morin' });
        expect(links).toHaveLength(1);
        expect(links[0].url).toBe('https://jira.wego.com/browse/PAY-123');
    });

    test('message_changed event uses event.message.text', async () => {
        const event = {
            subtype: 'message_changed',
            channel: 'C123',
            message: { text: 'updated text', ts: '111.111' },
        };
        const { body } = await normalize(event, makeCache());
        expect(body).toBe('updated text');
    });

    test('empty text returns empty body', async () => {
        const { body, mentions, links } = await normalize({ text: '' }, makeCache());
        expect(body).toBe('');
        expect(mentions).toEqual([]);
        expect(links).toEqual([]);
    });

    test('multiple mentions in same message', async () => {
        const cache = makeCache({ U1: 'Alice', U2: 'Bob' });
        const { body, mentions } = await normalize({ text: '<@U1> and <@U2> please review' }, cache);
        expect(body).toBe('@Alice and @Bob please review');
        expect(mentions).toHaveLength(2);
    });
});

describe('stripSlackFormatting', () => {
    test('bold', () => expect(stripSlackFormatting('*hi*')).toBe('hi'));
    test('strike', () => expect(stripSlackFormatting('~bye~')).toBe('bye'));
    test('no false-positive on URL with underscores', () => {
        // thread_ts in a URL should NOT be mangled by italic regex
        const url = 'https://slack.com/archives/C123/p123?thread_ts=456';
        expect(stripSlackFormatting(url)).toBe(url);
    });
});
