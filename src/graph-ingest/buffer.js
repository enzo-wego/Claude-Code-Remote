'use strict';

/**
 * T07: NDJSON append-only buffer + fsync.
 * T08: Drain/replay loop.
 *
 * File layout per day:
 *   {GRAPH_INGEST_BUFFER_PATH}/pending-YYYY-MM-DD.ndjson
 *   {GRAPH_INGEST_BUFFER_PATH}/pending-YYYY-MM-DD.offset  (byte offset of last forwarded line)
 *   {GRAPH_INGEST_BUFFER_PATH}/archived/pending-YYYY-MM-DD.ndjson
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_BUFFER_PATH = path.join(os.homedir(), '.enzobot', 'graph-buffer');
const DEFAULT_RETRY_INTERVAL_MS = 30000;
const DRAIN_BATCH_SIZE = 100;

function todayStr() {
    // YYYY-MM-DD in UTC
    return new Date().toISOString().slice(0, 10);
}

function pendingFile(dir, date) {
    return path.join(dir, `pending-${date}.ndjson`);
}

function offsetFile(dir, date) {
    return path.join(dir, `pending-${date}.offset`);
}

class NdjsonBuffer {
    constructor({ bufferPath, retryIntervalMs, forwarder, logger } = {}) {
        this.dir = bufferPath || process.env.GRAPH_INGEST_BUFFER_PATH || DEFAULT_BUFFER_PATH;
        this.retryIntervalMs = retryIntervalMs
            || parseInt(process.env.GRAPH_INGEST_RETRY_INTERVAL_MS, 10)
            || DEFAULT_RETRY_INTERVAL_MS;
        this.forwarder = forwarder || null;
        this.logger = logger || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        this._drainTimer = null;
        this._draining = false;
    }

    /**
     * Append a payload to today's NDJSON file. Fsyncs before returning.
     */
    append(payload) {
        fs.mkdirSync(this.dir, { recursive: true });
        const date = todayStr();
        const filePath = pendingFile(this.dir, date);
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            attempts: 0,
            payload,
        }) + '\n';

        const fd = fs.openSync(filePath, 'a');
        try {
            fs.writeSync(fd, line);
            try {
                fs.fdatasyncSync(fd);
            } catch (_) {
                // fdatasync not available on all platforms (e.g. macOS CI)
                fs.fsyncSync(fd);
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    /**
     * Start the background retry loop.
     */
    startDrainLoop() {
        if (this._drainTimer) return;
        this._drainTimer = setInterval(() => this.drain().catch(err =>
            this.logger.warn(`graph-ingest buffer: drain error: ${err.message}`)
        ), this.retryIntervalMs);
        if (this._drainTimer.unref) this._drainTimer.unref();
    }

    /**
     * Stop the background retry loop.
     */
    stopDrainLoop() {
        if (this._drainTimer) {
            clearInterval(this._drainTimer);
            this._drainTimer = null;
        }
    }

    /**
     * Read pending lines from today's file and forward them.
     * On 5xx/network error: stop batch, leave offset unchanged.
     * On 4xx: log + skip (advance offset).
     */
    async drain() {
        if (this._draining) return;
        this._draining = true;
        try {
            await this._drainFile(todayStr());
            // Also drain any older undrained files (previous day if bot was offline)
            await this._drainOldFiles();
        } finally {
            this._draining = false;
        }
    }

    async _drainFile(date) {
        const filePath = pendingFile(this.dir, date);
        if (!fs.existsSync(filePath)) return;

        const offPath = offsetFile(this.dir, date);
        let offset = 0;
        if (fs.existsSync(offPath)) {
            const raw = fs.readFileSync(offPath, 'utf8').trim();
            offset = parseInt(raw, 10) || 0;
        }

        const stat = fs.statSync(filePath);
        if (offset >= stat.size) {
            // Fully drained — archive if from a previous day
            if (date !== todayStr()) {
                this._archive(date);
            }
            return;
        }

        const fd = fs.openSync(filePath, 'r');
        try {
            let buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            const chunk = buf.toString('utf8');
            const rawLines = chunk.split('\n').filter(l => l.trim());
            const batch = rawLines.slice(0, DRAIN_BATCH_SIZE);

            for (const line of batch) {
                let record;
                try {
                    record = JSON.parse(line);
                } catch (_) {
                    // Corrupted line — skip it by advancing offset past this line
                    offset += Buffer.byteLength(line + '\n');
                    this._writeOffset(offPath, offset);
                    continue;
                }

                try {
                    await this.forwarder.post(record.payload);
                    // Success: advance offset
                    offset += Buffer.byteLength(line + '\n');
                    this._writeOffset(offPath, offset);
                } catch (err) {
                    if (err.fatal) {
                        // 4xx: skip, advance offset
                        this.logger.warn(`graph-ingest buffer: fatal forward error (skipping): ${err.message}`);
                        offset += Buffer.byteLength(line + '\n');
                        this._writeOffset(offPath, offset);
                    } else {
                        // 5xx / network / timeout: stop batch, leave offset unchanged
                        this.logger.warn(`graph-ingest buffer: retryable forward error (stopping batch): ${err.message}`);
                        return;
                    }
                }
            }

            // Archive if this was an older file and now fully drained
            if (date !== todayStr()) {
                const newStat = fs.statSync(filePath);
                if (offset >= newStat.size) {
                    this._archive(date);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    async _drainOldFiles() {
        let entries;
        try {
            entries = fs.readdirSync(this.dir);
        } catch (_) {
            return;
        }

        const today = todayStr();
        const oldDates = entries
            .filter(f => f.startsWith('pending-') && f.endsWith('.ndjson'))
            .map(f => f.slice('pending-'.length, -'.ndjson'.length))
            .filter(d => d !== today && d.match(/^\d{4}-\d{2}-\d{2}$/))
            .sort();

        for (const date of oldDates) {
            await this._drainFile(date);
        }
    }

    _writeOffset(offPath, offset) {
        fs.writeFileSync(offPath, String(offset), 'utf8');
    }

    _archive(date) {
        const archiveDir = path.join(this.dir, 'archived');
        fs.mkdirSync(archiveDir, { recursive: true });

        const src = pendingFile(this.dir, date);
        const dst = path.join(archiveDir, `pending-${date}.ndjson`);
        const offSrc = offsetFile(this.dir, date);

        try {
            fs.renameSync(src, dst);
        } catch (_) {}
        try {
            if (fs.existsSync(offSrc)) fs.unlinkSync(offSrc);
        } catch (_) {}

        this.logger.info(`graph-ingest buffer: archived ${date}`);
    }
}

module.exports = { NdjsonBuffer, pendingFile, offsetFile, todayStr };
