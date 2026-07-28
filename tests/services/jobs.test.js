const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');

const create = () => new Jobs(new Database(':memory:'));

describe('Jobs', () => {
    test('enqueue then lease claims oldest pending and returns payload', () => {
        const jobs = create();
        jobs.enqueue('review', { repo: 'wego/payments', pr: 412 }, { dedupeKey: 'review:wego/payments#412' });
        const leased = jobs.lease('mac');
        expect(leased.kind).toBe('review');
        expect(JSON.parse(leased.payload_json).pr).toBe(412);
        expect(leased.lease_id).toBeTruthy();
        expect(jobs.lease('mac')).toBeNull();
    });

    test('dedupe_key blocks duplicate live jobs but allows re-enqueue after done', () => {
        const jobs = create();
        const a = jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' });
        expect(jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' })).toBeNull();
        const leased = jobs.lease('mac');
        jobs.complete(leased.id, leased.lease_id, { ok: true });
        expect(jobs.enqueue('review', { pr: 1 }, { dedupeKey: 'k1' })).not.toBeNull();
        expect(a.id).toBeTruthy();
    });

    test('complete with wrong lease_id is rejected', () => {
        const jobs = create();
        jobs.enqueue('review', { pr: 2 });
        const leased = jobs.lease('mac');
        expect(jobs.complete(leased.id, 'wrong-lease', { ok: true })).toBe(false);
        expect(jobs.get(leased.id).status).toBe('leased');
    });

    test('expired lease is re-claimable; attempts increment; 3rd fail is terminal', () => {
        const jobs = create();
        jobs.enqueue('review', { pr: 3 });
        const l1 = jobs.lease('mac', { ttlMs: -1 });
        const l2 = jobs.lease('mac');
        expect(l2.id).toBe(l1.id);
        expect(l2.attempts).toBe(2);
        jobs.fail(l2.id, l2.lease_id, 'boom');
        const l3 = jobs.lease('mac');
        jobs.fail(l3.id, l3.lease_id, 'boom again');
        expect(jobs.get(l3.id).status).toBe('failed');
    });
});
