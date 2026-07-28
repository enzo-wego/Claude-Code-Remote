const { buildReviewResultBlocks, handleJobAction } = require('../../src/channels/slack/job-results');
const Database = require('better-sqlite3');
const Jobs = require('../../src/services/jobs');

describe('buildReviewResultBlocks', () => {
    test('renders summary and carries job id on buttons', () => {
        const blocks = buildReviewResultBlocks({
            id: 5,
            payload_json: JSON.stringify({
                repo: 'wego/payments',
                pr: 412,
                url: 'https://github.com/wego/payments/pull/412',
            }),
            result_json: JSON.stringify({
                summary: '2 blocking, 3 nits',
                body_md: '## Review\n...',
            }),
        });
        const actions = blocks.find(block => block.type === 'actions');
        expect(actions.elements.map(element => element.action_id)).toEqual([
            'job_post_review',
            'job_discard',
        ]);
        expect(actions.elements[0].value).toBe('5');
        expect(JSON.stringify(blocks)).toContain('2 blocking');
    });
});

describe('handleJobAction', () => {
    function setup() {
        const jobs = new Jobs(new Database(':memory:'));
        const row = jobs.enqueue('review', {
            repo: 'wego/payments',
            pr: 412,
        });
        const leased = jobs.lease('mac');
        jobs.complete(leased.id, leased.lease_id, {
            summary: 's',
            body_md: 'REVIEW BODY',
        });
        return { jobs, id: row.id };
    }

    test('job_post_review enqueues a post_review job carrying body_md', async () => {
        const { jobs, id } = setup();
        const reply = await handleJobAction({
            actionId: 'job_post_review',
            value: String(id),
            jobs,
        });
        const queued = jobs.lease('mac');
        expect(queued.kind).toBe('post_review');
        expect(JSON.parse(queued.payload_json).body_md).toBe('REVIEW BODY');
        expect(reply).toContain('queued');
    });

    test('job_discard replies without enqueuing', async () => {
        const { jobs, id } = setup();
        const reply = await handleJobAction({
            actionId: 'job_discard',
            value: String(id),
            jobs,
        });
        expect(jobs.lease('mac')).toBeNull();
        expect(reply).toContain('Discarded');
    });
});
