const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');
const AgentSessions = require('../../src/services/agent-sessions');
const { issueType, issueUrl } = require('../../src/services/agent-sessions');

function fresh() {
    const db = new Database(':memory:');
    return { prTasks: new PrTasks(db), sessions: new AgentSessions(db) };
}

const pr = (prTasks, number = 458) => prTasks.upsert({
    repo: 'wego/payments-react-component',
    number,
    url: `https://github.com/wego/payments-react-component/pull/${number}`,
    title: "[PAY-2266] Never revert the user's payment method",
    lane: 'mine',
});

describe('issue keys', () => {
    test('type and url are derived from the key shape', () => {
        expect(issueType('PAY-2266')).toBe('jira');
        expect(issueType('wego/payments#12')).toBe('gh_issue');
        expect(issueType('nonsense')).toBeNull();

        expect(issueUrl('PAY-2266', { jiraBase: 'https://x.atlassian.net' }))
            .toBe('https://x.atlassian.net/browse/PAY-2266');

        // The default host is the part that can be silently wrong — a derived
        // link pointing at the wrong tenant 404s instead of failing loudly.
        const saved = process.env.JIRA_BASE_URL;
        delete process.env.JIRA_BASE_URL;
        expect(issueUrl('PAY-2266'))
            .toBe('https://wegomushi.atlassian.net/browse/PAY-2266');
        if (saved !== undefined) process.env.JIRA_BASE_URL = saved;
        expect(issueUrl('wego/payments#12'))
            .toBe('https://github.com/wego/payments/issues/12');
        expect(issueUrl('nonsense')).toBeNull();
    });

    test('an unrecognized key is refused rather than stored untyped', () => {
        const { sessions } = fresh();
        expect(() => sessions.upsertIssue({ key: 'nonsense' })).toThrow(/unrecognized/);
        expect(() => sessions.upsertIssue({
            key: 'nonsense',
            type: 'jira',
        })).toThrow(/unrecognized/);
        expect(sessions.listIssues()).toEqual([]);
    });
});

describe('AgentSessions', () => {
    test('upsertIssue is idempotent and keeps the title it was given', () => {
        const { sessions } = fresh();
        const first = sessions.upsertIssue({ key: 'PAY-2266', title: 'Never revert' });
        const second = sessions.upsertIssue({ key: 'PAY-2266' });
        expect(second.id).toBe(first.id);
        expect(second.type).toBe('jira');
        expect(second.title).toBe('Never revert');
        expect(sessions.listIssues()).toHaveLength(1);
    });

    test('a session on the ticket is found through the PR', () => {
        const { prTasks, sessions } = fresh();
        const issue = sessions.upsertIssue({ key: 'PAY-2266' });
        const task = pr(prTasks);
        prTasks.setIssue(task.id, issue.id);

        // Opened during development, when no PR existed yet.
        sessions.add({
            key: 'aaaa-1111', issueId: issue.id,
            repo: 'wego/payments-react-component', label: 'feature dev',
        });

        const found = sessions.sessionsFor(task.id);
        expect(found.map(s => s.key)).toEqual(['aaaa-1111']);
        expect(found[0].label).toBe('feature dev');
    });

    test('PR-attached and ticket-attached sessions both surface, most-recently-used first', () => {
        let now = 1000;
        jest.spyOn(Date, 'now').mockImplementation(() => now++);
        const { prTasks, sessions } = fresh();
        const issue = sessions.upsertIssue({ key: 'PAY-2266' });
        const task = pr(prTasks);
        prTasks.setIssue(task.id, issue.id);

        const dev = sessions.add({ key: 'aaaa-1111', issueId: issue.id });
        const fix = sessions.add({ key: 'bbbb-2222', prId: task.id });
        sessions.touch(dev.id); // resumed after the PR session was created

        expect(sessions.sessionsFor(task.id).map(s => s.key))
            .toEqual(['aaaa-1111', 'bbbb-2222']);
        expect(sessions.get(fix.id).pr_id).toBe(task.id);
    });

    test('issues and sessions can be read and removed', () => {
        const { sessions } = fresh();
        const issue = sessions.upsertIssue({ key: 'PAY-2266' });
        const session = sessions.add({ key: 'aaaa-1111', issueId: issue.id });

        expect(sessions.issue(issue.id)).toEqual(issue);
        expect(sessions.issueByKey('PAY-2266')).toEqual(issue);
        expect(sessions.get(session.id)).toEqual(session);

        sessions.remove(session.id);
        expect(sessions.get(session.id)).toBeUndefined();
    });

    test('re-linking the same key updates the row instead of duplicating it', () => {
        const { prTasks, sessions } = fresh();
        const issue = sessions.upsertIssue({ key: 'PAY-2266' });
        const task = pr(prTasks);

        sessions.add({ key: 'aaaa-1111', issueId: issue.id });
        const again = sessions.add({ key: 'aaaa-1111', prId: task.id, label: 'dev' });

        expect(sessions.sessionsForIssue(issue.id)).toHaveLength(1);
        expect(again.pr_id).toBe(task.id);   // gained the PR
        expect(again.issue_id).toBe(issue.id); // kept the ticket
        expect(again.label).toBe('dev');
    });

    test('a PR with no linked ticket sees only its own sessions', () => {
        const { prTasks, sessions } = fresh();
        const issue = sessions.upsertIssue({ key: 'PAY-9999' });
        sessions.add({ key: 'other-ticket-session', issueId: issue.id });
        const task = pr(prTasks, 459);

        expect(sessions.sessionsFor(task.id)).toEqual([]);
    });

    test('a session attached to nothing is rejected — it could never be found again', () => {
        const { sessions } = fresh();
        expect(() => sessions.add({ key: 'orphan' })).toThrow(/PR or an issue/);
        expect(() => sessions.add({ prId: 1 })).toThrow(/resume key/);
    });
});
