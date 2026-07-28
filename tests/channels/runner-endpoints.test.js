const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');
const { makeRunnerHandlers } = require('../../src/channels/slack/runner-endpoints');

function setup() {
    const jobs = new Jobs(new Database(':memory:'));
    const onResult = jest.fn().mockResolvedValue();
    const handlers = makeRunnerHandlers({ jobs, token: 'sekret', onResult });
    const res = () => {
        const response = { code: 200, body: null };
        response.status = (code) => {
            response.code = code;
            return response;
        };
        response.json = (body) => {
            response.body = body;
            return response;
        };
        return response;
    };
    return { jobs, handlers, res, onResult };
}

describe('runner endpoints', () => {
    test('rejects bad token', async () => {
        const { handlers, res } = setup();
        const response = res();
        await handlers.lease({ headers: { 'x-runner-token': 'nope' }, body: {} }, response);
        expect(response.code).toBe(401);
    });

    test('lease returns null when empty, then a job after enqueue', async () => {
        const { jobs, handlers, res } = setup();
        const firstResponse = res();
        await handlers.lease({
            headers: { 'x-runner-token': 'sekret' },
            body: { target: 'mac' },
        }, firstResponse);
        expect(firstResponse.body.job).toBeNull();

        jobs.enqueue('review', { pr: 7 });
        const secondResponse = res();
        await handlers.lease({
            headers: { 'x-runner-token': 'sekret' },
            body: { target: 'mac' },
        }, secondResponse);
        expect(secondResponse.body.job.kind).toBe('review');
    });

    test('complete stores result and fires onResult', async () => {
        const { jobs, handlers, res, onResult } = setup();
        jobs.enqueue('review', { pr: 8 });
        const leased = jobs.lease('mac');
        const response = res();
        await handlers.complete({
            headers: { 'x-runner-token': 'sekret' },
            body: {
                job_id: leased.id,
                lease_id: leased.lease_id,
                result: { summary: 'ok' },
            },
        }, response);
        expect(response.body.ok).toBe(true);
        expect(jobs.get(leased.id).status).toBe('done');
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ id: leased.id }));
    });
});

/**
 * The daily restart closes the SQLite handle and _initDb() builds a fresh Jobs
 * instance. Handlers that captured the original one kept running prepared
 * statements against a closed connection, threw, and — because express 4 drops
 * a rejected promise — left the request hanging with no response. The Mac
 * runner polls with no fetch timeout, so that stopped it permanently.
 */
describe('survives a DB re-open (daily restart)', () => {
    test('lease uses the current Jobs instance, not the one captured at wiring', async () => {
        const first = new Jobs(new Database(':memory:'));
        let current = first;
        const handlers = makeRunnerHandlers({
            jobs: () => current,
            token: 'sekret',
        });

        first.db.close();          // what stop() does
        current = new Jobs(new Database(':memory:'));   // what _initDb() does
        current.enqueue('apex_review', { repo: 'wego/payments', pr: 1 });

        const response = { code: 200, body: null };
        response.status = code => { response.code = code; return response; };
        response.json = body => { response.body = body; return response; };

        await handlers.lease(
            { headers: { 'x-runner-token': 'sekret' }, body: { target: 'mac' } },
            response
        );

        expect(response.code).toBe(200);
        expect(response.body.job).toEqual(
            expect.objectContaining({ kind: 'apex_review' })
        );
    });

    test('a throwing handler answers 500 instead of hanging', async () => {
        const jobs = new Jobs(new Database(':memory:'));
        const handlers = makeRunnerHandlers({ jobs, token: 'sekret' });
        jobs.db.close();

        const response = { code: 200, body: null };
        response.status = code => { response.code = code; return response; };
        response.json = body => { response.body = body; return response; };

        await handlers.lease(
            { headers: { 'x-runner-token': 'sekret' }, body: {} },
            response
        );

        expect(response.code).toBe(500);
        expect(response.body.error).toMatch(/not open/);
    });
});

describe('terminal failure notification', () => {
    const resFactory = () => {
        const response = { code: 200, body: null };
        response.status = code => { response.code = code; return response; };
        response.json = body => { response.body = body; return response; };
        return response;
    };

    /** Three attempts land as one DM, not three. */
    test('onFail fires only when the queue gives up', async () => {
        const jobs = new Jobs(new Database(':memory:'));
        const onFail = jest.fn().mockResolvedValue();
        const handlers = makeRunnerHandlers({ jobs, token: 'sekret', onFail });
        const job = jobs.enqueue('apex_review', { repo: 'wego/payments', pr: 1 });

        for (let attempt = 1; attempt <= 3; attempt++) {
            const leased = jobs.lease('mac');
            expect(leased).not.toBeNull();
            await handlers.fail(
                {
                    headers: { 'x-runner-token': 'sekret' },
                    body: { job_id: job.id, lease_id: leased.lease_id, error: 'boom' },
                },
                resFactory()
            );
        }

        expect(onFail).toHaveBeenCalledTimes(1);
        expect(onFail.mock.calls[0][0]).toEqual(expect.objectContaining({
            status: 'failed',
            kind: 'apex_review',
            attempts: 3,
        }));
    });
});
