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

describe('pr_process', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const agentSessions = sessions => ({
        sessionsFor: jest.fn().mockReturnValue(sessions),
        get: jest.fn(id => sessions.find(session => session.id === id)),
        touch: jest.fn(),
    });
    const queuedPayload = jobs => {
        const job = jobs.lease('mac');
        return {
            job,
            payload: JSON.parse(job.payload_json),
        };
    };

    /**
     * The runner only knows `claude --resume <key>`. Codex resumes with
     * `codex resume <id>`, so a Codex key would launch Claude against an id it
     * has never seen, start a fresh conversation, and compact that instead —
     * the failure mode the whole session index exists to prevent.
     */
    test('refuses a session the runner cannot resume, and queues nothing', async () => {
        const { jobs, prTasks, task } = setup();
        const sessions = agentSessions([{
            id: 9, key: '019fb0e1-f535-70a2-a5d6-6d9156855a5e',
            cli: 'codex', label: 'PAY-2266 458', last_used_at: Date.now(),
        }]);

        const reply = await handlePrAction({
            actionId: 'pr_process',
            value: String(task.id),
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        expect(reply).toContain('codex session');
        expect(jobs.lease('mac')).toBeFalsy();
        expect(sessions.touch).not.toHaveBeenCalled();
    });

    test('refuses the same way when the session was chosen from the picker', async () => {
        const { jobs, prTasks, task } = setup();
        const sessions = agentSessions([{
            id: 9, key: 'abcdef12', cli: 'codex', label: null,
            created_at: Date.now(),
        }]);

        const reply = await handlePrAction({
            actionId: 'pr_process_with',
            value: `${task.id}:9`,
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        expect(reply).toContain('codex session');
        expect(jobs.lease('mac')).toBeFalsy();
        expect(sessions.touch).not.toHaveBeenCalled();
    });

    test('starts fresh when the PR has no recorded session', async () => {
        const { jobs, prTasks, task } = setup();
        const sessions = agentSessions([]);

        const reply = await handlePrAction({
            actionId: 'pr_process',
            value: String(task.id),
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        const { job, payload } = queuedPayload(jobs);
        expect(job.kind).toBe('address_comments');
        expect(payload).toEqual({
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            title: 'Fix tax rounding',
            sessionKey: null,
            cli: null,
            threads: null,
        });
        expect(sessions.touch).not.toHaveBeenCalled();
        expect(reply).toContain('Processing #412');
    });

    test('resumes and touches the only session, while a double tap dedupes', async () => {
        const { jobs, prTasks, task } = setup();
        const session = {
            id: 71,
            key: 'aaaa-1111',
            cli: 'claude',
            label: 'feature dev',
            created_at: Date.now() - 86_400_000,
            last_used_at: null,
        };
        const sessions = agentSessions([session]);

        const first = await handlePrAction({
            actionId: 'pr_process',
            value: String(task.id),
            prTasks,
            jobs,
            agentSessions: sessions,
        });
        const second = await handlePrAction({
            actionId: 'pr_process',
            value: String(task.id),
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        const { job, payload } = queuedPayload(jobs);
        expect(job.kind).toBe('address_comments');
        expect(payload).toEqual({
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            title: 'Fix tax rounding',
            sessionKey: 'aaaa-1111',
            cli: 'claude',
            threads: null,
        });
        expect(sessions.touch).toHaveBeenCalledWith(71);
        expect(first).toContain('Processing #412');
        expect(second).toBe(
            ':information_source: Processing for #412 is already queued.'
        );
    });

    test('offers every candidate and enqueues nothing when more than one exists', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-30T12:00:00Z'));
        const { jobs, prTasks, task } = setup();
        const sessions = agentSessions([
            {
                id: 71,
                key: 'aaaa-1111-rest-of-key',
                cli: 'claude',
                label: 'feature dev',
                created_at: Date.parse('2026-07-29T12:00:00Z'),
                last_used_at: Date.parse('2026-07-30T10:00:00Z'),
            },
            {
                id: 72,
                key: 'bbbb-2222-rest-of-key',
                cli: 'claude',
                label: null,
                created_at: Date.parse('2026-07-27T12:00:00Z'),
                last_used_at: null,
            },
        ]);

        const reply = await handlePrAction({
            actionId: 'pr_process',
            value: String(task.id),
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        expect(jobs.recent()).toEqual([]);
        expect(reply.text).toContain('Choose a session');
        const buttons = reply.blocks
            .find(block => block.type === 'actions')
            .elements;
        expect(buttons.map(button => ({
            actionId: button.action_id,
            value: button.value,
            text: button.text.text,
        }))).toEqual([
            {
                actionId: 'pr_process_with',
                value: `${task.id}:71`,
                text: 'feature dev · 2h ago',
            },
            {
                actionId: 'pr_process_with',
                value: `${task.id}:72`,
                text: 'bbbb-222 · 3d ago',
            },
        ]);
    });

    test('the picker resumes exactly the chosen session and touches it', async () => {
        const { jobs, prTasks, task } = setup();
        // Both resumable, so what this proves is that the *chosen* session wins
        // rather than the first one. A Codex candidate here would be refused
        // before it could be enqueued — see the two refusal tests above.
        const candidates = [
            { id: 71, key: 'aaaa-1111', cli: 'claude', label: 'feature dev' },
            { id: 72, key: 'bbbb-2222', cli: 'claude', label: 'review fixes' },
        ];
        const sessions = agentSessions(candidates);

        const reply = await handlePrAction({
            actionId: 'pr_process_with',
            value: `${task.id}:72`,
            prTasks,
            jobs,
            agentSessions: sessions,
        });

        const { payload } = queuedPayload(jobs);
        expect(payload).toEqual({
            repo: 'wego/payments',
            pr: 412,
            url: 'https://github.com/wego/payments/pull/412',
            title: 'Fix tax rounding',
            sessionKey: 'bbbb-2222',
            cli: 'claude',
            threads: null,
        });
        expect(sessions.touch).toHaveBeenCalledWith(72);
        expect(reply).toContain('Processing #412');
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
