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
