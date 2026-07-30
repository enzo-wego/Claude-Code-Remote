const Database = require('better-sqlite3');
const PrTasks = require('../../src/services/pr-tasks');

const create = () => new PrTasks(new Database(':memory:'));

describe('PrTasks', () => {
    test('upsert dedupes by repo#number; updates ci/review state', () => {
        const tasks = create();
        const first = tasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'u',
            origin: 'slack',
        });
        const second = tasks.upsert({
            repo: 'wego/payments',
            number: 412,
            url: 'u',
            ci: 'green',
            reviewState: 'requested',
        });
        expect(second.id).toBe(first.id);
        expect(tasks.get(first.id).ci).toBe('green');
    });

    test('reviewReady = ci green AND review requested AND status active', () => {
        const tasks = create();
        const task = tasks.upsert({
            repo: 'r',
            number: 1,
            url: 'u',
            ci: 'green',
            reviewState: 'requested',
        });
        expect(tasks.reviewReady()).toHaveLength(1);
        tasks.setStatus(task.id, 'posted');
        expect(tasks.reviewReady()).toHaveLength(0);
    });

    test('setStatus transitions; listActive excludes done/dismissed', () => {
        const tasks = create();
        const task = tasks.upsert({ repo: 'r', number: 2, url: 'u' });
        tasks.setStatus(task.id, 'reviewing');
        expect(tasks.listActive()).toHaveLength(1);
        tasks.setStatus(task.id, 'dismissed');
        expect(tasks.listActive()).toHaveLength(0);
    });

    test('setSlackThread round-trips and fresh rows have no thread', () => {
        const tasks = create();
        const task = tasks.upsert({ repo: 'r', number: 3, url: 'u' });
        expect(tasks.get(task.id)).toMatchObject({
            slack_ts: null,
            slack_permalink: null,
        });

        tasks.setSlackThread(task.id, '123.456', 'https://slack.example/thread');

        expect(tasks.get(task.id)).toMatchObject({
            slack_ts: '123.456',
            slack_permalink: 'https://slack.example/thread',
        });
        expect(tasks.byRepoNumber('r', 3).id).toBe(task.id);
    });
});
