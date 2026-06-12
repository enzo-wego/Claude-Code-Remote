/**
 * attachments — `Attachment written:` marker scan + guarded Slack upload.
 * Mirrors the contract socket.js _uploadResponseAttachments established,
 * now shared with cli-hook-notify.js for regular @mention chat.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    extractAttachmentPaths,
    isSensitivePath,
    uploadResponseAttachments,
    MAX_ATTACHMENTS_PER_REPLY,
} = require('../../src/utils/attachments');

describe('extractAttachmentPaths', () => {
    test('finds plain and backticked markers, dedupes, strips trailing punctuation', () => {
        const text = [
            'Done. Attachment written: /tmp/a/report.md.',
            'Also Attachment written: `/tmp/b/data.csv`',
            'attachment written: /tmp/a/report.md',
        ].join('\n');
        expect(extractAttachmentPaths(text)).toEqual(['/tmp/a/report.md', '/tmp/b/data.csv']);
    });

    test('returns [] for empty / non-string / marker-free input', () => {
        expect(extractAttachmentPaths('')).toEqual([]);
        expect(extractAttachmentPaths(null)).toEqual([]);
        expect(extractAttachmentPaths('no markers here, file at /tmp/x.txt')).toEqual([]);
    });
});

describe('isSensitivePath', () => {
    test.each([
        '/home/enzo/.env',
        '/home/enzo/.env.production',
        '/home/enzo/.ssh/known_hosts',
        '/home/enzo/.aws/config',
        '/etc/certs/server.pem',
        '/home/enzo/id_rsa',
    ])('blocks %s', (p) => {
        expect(isSensitivePath(p)).toBe(true);
    });

    test.each([
        '/tmp/wf551/fixed_crisis_csv.sql',
        '/tmp/report.md',
        '/var/log/app/env-summary.txt',
    ])('allows %s', (p) => {
        expect(isSensitivePath(p)).toBe(false);
    });
});

describe('uploadResponseAttachments', () => {
    let tmpDir;
    let web;
    const log = { info: () => {}, warn: () => {} };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
        web = { filesUploadV2: jest.fn().mockResolvedValue({ ok: true }) };
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeTmp(name, content = 'hello') {
        const p = path.join(tmpDir, name);
        fs.writeFileSync(p, content);
        return p;
    }

    test('uploads a referenced file to the right channel/thread', async () => {
        const file = writeTmp('report.sql', 'SELECT 1;');
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '123.456',
            response: `Done.\nAttachment written: ${file}`,
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toEqual([file]);
        expect(web.filesUploadV2).toHaveBeenCalledTimes(1);
        const arg = web.filesUploadV2.mock.calls[0][0];
        expect(arg.channel_id).toBe('C1');
        expect(arg.thread_ts).toBe('123.456');
        expect(arg.filename).toBe('report.sql');
    });

    test('resolves relative paths against baseDir', async () => {
        writeTmp('rel.txt');
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: 'Attachment written: rel.txt',
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toEqual([path.join(tmpDir, 'rel.txt')]);
    });

    test('no markers → no upload calls', async () => {
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: 'plain reply, nothing to attach',
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toEqual([]);
        expect(web.filesUploadV2).not.toHaveBeenCalled();
    });

    test('skips missing files without throwing', async () => {
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: `Attachment written: ${path.join(tmpDir, 'nope.txt')}`,
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toEqual([]);
        expect(res.skipped).toHaveLength(1);
        expect(web.filesUploadV2).not.toHaveBeenCalled();
    });

    test('refuses sensitive paths even when the file exists', async () => {
        const secret = writeTmp('fake.pem', 'KEY');
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: `Attachment written: ${secret}`,
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toEqual([]);
        expect(res.skipped[0].reason).toBe('sensitive-path');
        expect(web.filesUploadV2).not.toHaveBeenCalled();
    });

    test('caps the number of uploads per reply', async () => {
        const lines = [];
        for (let i = 0; i < MAX_ATTACHMENTS_PER_REPLY + 2; i++) {
            lines.push(`Attachment written: ${writeTmp(`f${i}.txt`)}`);
        }
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: lines.join('\n'),
            baseDir: tmpDir, log,
        });
        expect(res.uploaded).toHaveLength(MAX_ATTACHMENTS_PER_REPLY);
        expect(res.skipped.filter((s) => s.reason === 'attachment-count-cap')).toHaveLength(2);
    });

    test('upload failure is tolerated and reported in skipped', async () => {
        web.filesUploadV2.mockRejectedValueOnce(new Error('slack 500'));
        const ok = writeTmp('ok.txt');
        const bad = writeTmp('bad.txt');
        const res = await uploadResponseAttachments({
            web, channelId: 'C1', threadTs: '1.2',
            response: `Attachment written: ${bad}\nAttachment written: ${ok}`,
            baseDir: tmpDir, log,
        });
        expect(res.skipped[0].reason).toBe('slack 500');
        expect(res.uploaded).toEqual([ok]);
    });
});
