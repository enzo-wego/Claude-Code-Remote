/**
 * Attachment Upload Helper
 *
 * Shared by cli-hook-notify.js (regular @mention chat) and available to
 * socket.js. Scans a CLI reply for the explicit marker
 *
 *     Attachment written: <path>
 *
 * and uploads each referenced file to the Slack thread via filesUploadV2.
 * The marker is an explicit opt-in by the in-tmux CLI — we deliberately do
 * NOT auto-detect bare file paths in replies, because replies routinely
 * mention paths nobody wants posted (source files, .env, secrets) and alert
 * sessions ingest external text, which would turn implicit detection into a
 * prompt-injection exfiltration channel.
 */

const fs = require('fs');
const path = require('path');

// Upload guards. The deny-list blocks the obvious secret-exfil targets even
// when the marker names them; size/count caps keep a runaway reply from
// flooding the thread or stalling the Stop hook past its timeout.
const MAX_ATTACHMENTS_PER_REPLY = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

const SENSITIVE_BASENAMES = [
    /^\.env(\..*)?$/i,
    /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
    /^credentials(\..*)?$/i,
    /^\.netrc$/i,
    /^\.npmrc$/i,
];
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const SENSITIVE_DIRS = ['/.ssh/', '/.aws/', '/.gnupg/'];

function extractAttachmentPaths(response) {
    if (!response || typeof response !== 'string') return [];
    const paths = [];
    const seen = new Set();
    const re = /Attachment written:\s*`?([^\s`\n]+)`?/gi;
    for (const m of response.matchAll(re)) {
        const cleaned = m[1].replace(/[.,;:!?)\]]+$/, '').trim();
        if (cleaned && !seen.has(cleaned)) {
            seen.add(cleaned);
            paths.push(cleaned);
        }
    }
    return paths;
}

function isSensitivePath(absPath) {
    const base = path.basename(absPath);
    if (SENSITIVE_BASENAMES.some((re) => re.test(base))) return true;
    if (SENSITIVE_EXTENSIONS.includes(path.extname(base).toLowerCase())) return true;
    const normalized = absPath.replace(/\\/g, '/');
    return SENSITIVE_DIRS.some((dir) => normalized.includes(dir));
}

/**
 * Upload every `Attachment written:` file referenced in `response` to the
 * given Slack thread. Never throws — a failed upload must not break the
 * reply that was already posted.
 *
 * @param {object} opts
 * @param {object} opts.web       Slack WebClient (or app.client) exposing filesUploadV2
 * @param {string} opts.channelId
 * @param {string} opts.threadTs
 * @param {string} opts.response  the CLI reply text to scan
 * @param {string} opts.baseDir   directory relative paths resolve against (CLI cwd)
 * @param {object} [opts.log]     { info, warn } — defaults to console.error
 * @returns {Promise<{uploaded: string[], skipped: Array<{path: string, reason: string}>}>}
 */
async function uploadResponseAttachments({ web, channelId, threadTs, response, baseDir, log }) {
    const info = (log && log.info) || ((msg) => console.error(msg));
    const warn = (log && log.warn) || ((msg) => console.error(msg));
    const uploaded = [];
    const skipped = [];

    const candidates = extractAttachmentPaths(response);
    if (!candidates.length) return { uploaded, skipped };

    const overflow = candidates.splice(MAX_ATTACHMENTS_PER_REPLY);
    for (const dropped of overflow) {
        skipped.push({ path: dropped, reason: 'attachment-count-cap' });
        warn(`Attachment cap (${MAX_ATTACHMENTS_PER_REPLY}) exceeded, skipping: ${dropped}`);
    }

    for (const rel of candidates) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(baseDir || process.cwd(), rel);
        try {
            if (isSensitivePath(abs)) {
                skipped.push({ path: abs, reason: 'sensitive-path' });
                warn(`Attachment path looks sensitive, refusing to upload: ${abs}`);
                continue;
            }
            const stat = fs.statSync(abs);
            if (!stat.isFile()) {
                skipped.push({ path: abs, reason: 'not-a-file' });
                warn(`Attachment path is not a regular file, skipping: ${abs}`);
                continue;
            }
            if (stat.size > MAX_ATTACHMENT_BYTES) {
                skipped.push({ path: abs, reason: 'too-large' });
                warn(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes (${stat.size}), skipping: ${abs}`);
                continue;
            }
            // Buffer, not createReadStream: if filesUploadV2 rejects before
            // consuming the stream, the stream's own error event is unhandled
            // and would crash the (short-lived) hook process. Files are capped
            // at MAX_ATTACHMENT_BYTES, so buffering is fine.
            await web.filesUploadV2({
                channel_id: channelId,
                thread_ts: threadTs,
                file: fs.readFileSync(abs),
                filename: path.basename(abs),
                title: path.basename(abs),
            });
            uploaded.push(abs);
            info(`Uploaded chat attachment ${abs} (${stat.size} bytes) to thread ${threadTs}`);
        } catch (err) {
            skipped.push({ path: abs, reason: err.message });
            warn(`Failed to upload attachment "${rel}" (resolved=${abs}): ${err.message}`);
        }
    }

    return { uploaded, skipped };
}

module.exports = {
    extractAttachmentPaths,
    isSensitivePath,
    uploadResponseAttachments,
    MAX_ATTACHMENTS_PER_REPLY,
    MAX_ATTACHMENT_BYTES,
};
