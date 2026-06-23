'use strict';

/**
 * T06: Tests for src/graph-ingest/filter.js
 */

const { shouldIngest } = require('../../src/graph-ingest/filter');

const ALLOWED = ['C08S954G2LX', 'C05RNSE8TBR', 'CUV9EAYGY', 'C0597404MS6'];
const opts = { allowedChannels: ALLOWED, enzoBotUserId: 'UBOT123' };

function event(overrides = {}) {
    return {
        channel: 'C05RNSE8TBR',
        user: 'U_HUMAN',
        text: 'hello',
        ts: '111.111',
        ...overrides,
    };
}

describe('filter: shouldIngest', () => {

    describe('channel allowlist', () => {
        test('allowed channel passes', () => {
            expect(shouldIngest(event(), opts).pass).toBe(true);
        });

        test('channel not in allowlist is dropped', () => {
            expect(shouldIngest(event({ channel: 'COTHER' }), opts).pass).toBe(false);
        });

        test('all four configured channels pass', () => {
            for (const ch of ALLOWED) {
                expect(shouldIngest(event({ channel: ch }), opts).pass).toBe(true);
            }
        });
    });

    describe('bot-self filter', () => {
        test('event from EnzoBot user is dropped', () => {
            expect(shouldIngest(event({ user: 'UBOT123' }), opts).pass).toBe(false);
        });

        test('event with EnzoBot bot_id is dropped', () => {
            expect(shouldIngest(event({ bot_id: 'UBOT123' }), opts).pass).toBe(false);
        });

        test('event from different bot_id passes', () => {
            expect(shouldIngest(event({ bot_id: 'BOTOTHER' }), opts).pass).toBe(true);
        });

        test('event from human passes', () => {
            expect(shouldIngest(event({ user: 'U_HUMAN' }), opts).pass).toBe(true);
        });
    });

    describe('skip subtypes', () => {
        test('channel_join is dropped', () => {
            expect(shouldIngest(event({ subtype: 'channel_join' }), opts).pass).toBe(false);
        });

        test('channel_leave is dropped', () => {
            expect(shouldIngest(event({ subtype: 'channel_leave' }), opts).pass).toBe(false);
        });

        test('message_replied is dropped', () => {
            expect(shouldIngest(event({ subtype: 'message_replied' }), opts).pass).toBe(false);
        });

        test('bot_message is dropped by default', () => {
            expect(shouldIngest(event({ subtype: 'bot_message' }), opts).pass).toBe(false);
        });

        test('custom skip subtype from config is dropped', () => {
            const customOpts = { ...opts, skipSubtypes: ['file_share'] };
            expect(shouldIngest(event({ subtype: 'file_share' }), customOpts).pass).toBe(false);
        });

        test('no subtype (normal message) passes', () => {
            expect(shouldIngest(event(), opts).pass).toBe(true);
        });
    });

    describe('message_changed handling', () => {
        test('message_changed passes with edit metadata', () => {
            const result = shouldIngest(event({
                subtype: 'message_changed',
                message: { edited: { ts: '222.222' } },
            }), opts);
            expect(result.pass).toBe(true);
            expect(result.metadata.subtype).toBe('message_changed');
            expect(result.metadata.edited).toBe(true);
            expect(result.metadata.body_ts).toBe('222.222');
        });

        test('message_changed from bot channel still passes (edit metadata set)', () => {
            // message_changed doesn't go through bot_id filter the same way
            const result = shouldIngest(event({
                subtype: 'message_changed',
                channel: 'C05RNSE8TBR',
            }), opts);
            expect(result.pass).toBe(true);
        });
    });

    describe('message_deleted handling', () => {
        test('message_deleted passes with delete metadata', () => {
            const result = shouldIngest(event({ subtype: 'message_deleted' }), opts);
            expect(result.pass).toBe(true);
            expect(result.metadata.subtype).toBe('message_deleted');
            expect(result.metadata.deleted).toBe(true);
        });
    });

    describe('empty allowlist', () => {
        test('all channels dropped when allowlist is empty', () => {
            const result = shouldIngest(event(), { allowedChannels: [] });
            expect(result.pass).toBe(false);
        });
    });
});
