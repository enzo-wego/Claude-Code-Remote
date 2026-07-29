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

    
    test('pr_dismiss removes the row from the board', async () => {
        const { jobs, prTasks, task } = setup();
        const reply = await handlePrAction({
            actionId: 'pr_dismiss', value: String(task.id), prTasks, jobs,
        });
        expect(prTasks.get(task.id).status).toBe('dismissed');
        expect(reply).toContain('Dismissed');
    });
});


/**
 * Post, Edit and Exit all talk to the reviewer still sitting in its pane rather
 * than reconstructing its work on this side.
 */
describe('actions relay to the live review session', () => {
    const drafted = (lane, verdict, paneId = 'wN:p2') => {
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
        jobs.complete(job.id, leased.lease_id, {
            body_md: 'LGTM', verdict, pane_id: paneId,
        });
        prTasks.setDraftJob(task.id, job.id);
        return { jobs, prTasks, task };
    };

    const relayed = (jobs, kind = 'pane_message') =>
        JSON.parse(jobs.recent(10).find(j => j.kind === kind).payload_json);

    test('Post tells the reviewer to post as a comment', async () => {
        const { jobs, prTasks, task } = drafted('team', 'comment');
        const reply = await handlePrAction({
            actionId: 'pr_post', value: String(task.id), prTasks, jobs,
        });
        const sent = relayed(jobs);
        expect(sent.pane_id).toBe('wN:p2');
        expect(sent.text).toContain('COMMENT');
        expect(sent.text).not.toContain('APPROVAL');
        expect(reply).toContain('post');
    });

    test('a clean verdict on a teammate PR asks for an approval', async () => {
        const { jobs, prTasks, task } = drafted('team', 'approve');
        await handlePrAction({ actionId: 'pr_post', value: String(task.id), prTasks, jobs });
        expect(relayed(jobs).text).toContain('APPROVAL');
    });

    test('your own PR is never asked to self-approve', async () => {
        const { jobs, prTasks, task } = drafted('mine', 'approve');
        await handlePrAction({ actionId: 'pr_post', value: String(task.id), prTasks, jobs });
        expect(relayed(jobs).text).toContain('COMMENT');
    });

    test('Edit forwards the instructions and asks for a repost', async () => {
        const { jobs, prTasks, task } = drafted('team', 'comment');
        await handlePrAction({
            actionId: 'pr_revise', value: String(task.id), prTasks, jobs,
            instructions: 'drop the nit, shorten the body',
        });
        const sent = relayed(jobs);
        expect(sent.text).toContain('drop the nit, shorten the body');
        expect(sent.text).toMatch(/post the revised review/i);
    });

    test('Exit closes the session, queues no post, and keeps the PR reviewable', async () => {
        const { jobs, prTasks, task } = drafted('team', 'comment');
        const reply = await handlePrAction({
            actionId: 'pr_discard', value: String(task.id), prTasks, jobs,
        });
        expect(relayed(jobs, 'pane_close').pane_id).toBe('wN:p2');
        expect(jobs.recent(10).some(j => j.kind === 'pane_message')).toBe(false);
        const row = prTasks.get(task.id);
        expect(row.status).toBe('detected');
        expect(row.draft_job_id).toBeNull();
        expect(reply).toContain('Nothing was posted');
    });

    test('a draft with no live pane refuses rather than pretending', async () => {
        const { jobs, prTasks, task } = drafted('team', 'comment', null);
        const reply = await handlePrAction({
            actionId: 'pr_post', value: String(task.id), prTasks, jobs,
        });
        expect(reply).toContain('No live review session');
        expect(jobs.recent(10).some(j => j.kind === 'pane_message')).toBe(false);
    });
});
