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
