const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');
const PrTasks = require('../../src/services/pr-tasks');
const { handlePrAction } = require('../../src/channels/slack/pr-actions');

function setup() {
    const db = new Database(':memory:');
    const jobs = new Jobs(db);
    const prTasks = new PrTasks(db);
    const task = prTasks.upsert({
        repo: 'wego/payments',
        number: 412,
        url: 'https://github.com/wego/payments/pull/412',
        title: 'Fix tax rounding',
    });
    return { jobs, prTasks, task };
}

describe('handlePrAction', () => {
    test('pr_review_now enqueues apex_review and marks the task reviewing', async () => {
        const { jobs, prTasks, task } = setup();
        const reply = await handlePrAction({
            actionId: 'pr_review_now',
            value: String(task.id),
            prTasks,
            jobs,
        });

        const queued = jobs.lease('mac');
        expect(queued.kind).toBe('apex_review');
        expect(JSON.parse(queued.payload_json)).toEqual({
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            // Rides along so the Mac can name the herdr tab after the ticket.
            title: 'Fix tax rounding',
        });
        expect(prTasks.get(task.id)).toEqual(expect.objectContaining({
            status: 'reviewing',
            draft_job_id: queued.id,
        }));
        expect(reply).toContain('Reviewing #412');
    });

    test('pr_post enqueues post_review from the completed draft', async () => {
        const { jobs, prTasks, task } = setup();
        const draft = jobs.enqueue('apex_review', {
            repo: task.repo,
            pr: task.number,
            url: task.url,
        });
        const leased = jobs.lease('mac');
        jobs.complete(leased.id, leased.lease_id, {
            body_md: 'DRAFT REVIEW',
            summary: '1 blocking',
        });
        prTasks.setDraftJob(task.id, draft.id);
        prTasks.setStatus(task.id, 'drafted');

        const reply = await handlePrAction({
            actionId: 'pr_post',
            value: String(task.id),
            prTasks,
            jobs,
        });

        const queued = jobs.lease('mac');
        expect(queued.kind).toBe('post_review');
        expect(JSON.parse(queued.payload_json).body_md).toBe('DRAFT REVIEW');
        expect(prTasks.get(task.id).status).toBe('posted');
        expect(reply).toContain('queued');
    });

    test.each(['pr_discard', 'pr_dismiss'])('%s dismisses the PR task', async (actionId) => {
        const { jobs, prTasks, task } = setup();
        const reply = await handlePrAction({
            actionId,
            value: String(task.id),
            prTasks,
            jobs,
        });

        expect(prTasks.get(task.id).status).toBe('dismissed');
        expect(reply).toContain('Dismissed');
    });
});

describe('approve only when earned', () => {
    const draftedWith = (lane, verdict) => {
        const db = new Database(':memory:');
        const jobs = new Jobs(db);
        const prTasks = new PrTasks(db);
        const task = prTasks.upsert({
            repo: 'wego/payments', number: 2210,
            url: 'https://github.com/wego/payments/pull/2210',
            title: 'PAY-2225: counters', lane,
        });
        const job = jobs.enqueue('apex_review', { repo: 'wego/payments', pr: 2210 });
        const leased = jobs.lease('mac');
        jobs.complete(job.id, leased.lease_id, { body_md: 'LGTM', verdict });
        prTasks.setDraftJob(task.id, job.id);
        return { jobs, prTasks, task };
    };

    const methodAfterPost = async (lane, verdict) => {
        const { jobs, prTasks, task } = draftedWith(lane, verdict);
        const reply = await handlePrAction({
            actionId: 'pr_post', value: String(task.id), prTasks, jobs,
        });
        const posted = jobs.recent(10).find(j => j.kind === 'post_review');
        return { method: JSON.parse(posted.payload_json).method, reply };
    };

    test('a clean verdict on a teammate PR files an approval', async () => {
        const { method, reply } = await methodAfterPost('team', 'approve');
        expect(method).toBe('approve');
        expect(reply).toContain('Approving');
    });

    test('blocking findings stay a comment', async () => {
        expect((await methodAfterPost('team', 'comment')).method).toBe('comment');
    });

    test('your own PR never self-approves, however clean', async () => {
        const { method } = await methodAfterPost('mine', 'approve');
        expect(method).toBe('comment');
    });

    test('a draft with no verdict at all stays a comment', async () => {
        const { method } = await methodAfterPost('team', undefined);
        expect(method).toBe('comment');
    });
});
