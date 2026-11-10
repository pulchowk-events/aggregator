// src/core/markers.js
// Durable cross-process "was this posted?" source of truth.
//
// Each event+channel combination gets one JSON marker file:
//
//   data/posted-channel-markers/<sha1(dedupKey::channelId)>.json
//
// The file has three states:
//   reserved  — someone claimed the slot; `reservedAt` + `heartbeatAt` set
//   confirmed — `postedAt` set (the actual post went out)
//   (gone)    — file was deleted (the slot was released after a failed
//               send, or was never there)
//
// Why a heartbeat at all: a slow-but-alive send (image download taking 20s)
// keeps refreshing `heartbeatAt` so it never reads as an abandoned
// reservation to a concurrent poster. Measured from latest heartbeat, not
// original reservedAt.
//
// Fail-closed policy:
//   If a stale reservation can't be verified against Discord (network
//   error, rate limit, no title to match), the caller is told the slot is
//   STILL OCCUPIED. Better to risk a very rare skip than a duplicate post.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auditLog } = require('./auditLogger');
const { STALE_RESERVATION_MS, RECONCILIATION_MESSAGE_FETCH_LIMIT } = require('../config/constants');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const MARKERS_DIR = path.join(DATA_DIR, 'posted-channel-markers');

function ensureMarkersDir() {
    try {
        if (!fs.existsSync(MARKERS_DIR)) fs.mkdirSync(MARKERS_DIR, { recursive: true });
    } catch (error) {
        console.error('❌ Failed to create posted-markers directory:', error);
    }
}

// Deterministic file path for a (dedupKey, channelId) pair.
function markerPathFor(dedupKey, channelId) {
    const hash = crypto.createHash('sha1').update(`${dedupKey}::${channelId}`).digest('hex');
    return path.join(MARKERS_DIR, `${hash}.json`);
}

// Read the marker for a (dedupKey, channelId) pair, or null if none.
// Returns { path, data } so callers that upgrade (reserved -> confirmed)
// don't have to recompute the path.
function read(dedupKey, channelId) {
    const filePath = markerPathFor(dedupKey, channelId);
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return { path: filePath, data: JSON.parse(raw) };
    } catch (e) {
        return null;
    }
}

// Atomically claim the slot. Returns true on success, false if it was
// already claimed (race) or the write failed unexpectedly.
//
// `force` behaves like the original bot: if a CONFIRMED marker already
// exists, delete it and re-reserve — that's the "Yes, post it again"
// confirmation path. A RESERVED (not posted) marker is NOT overwritten
// by force, because the other instance might still be mid-send.
function reserve(dedupKey, channelId, { title = null, force = false } = {}) {
    ensureMarkersDir();
    const filePath = markerPathFor(dedupKey, channelId);

    if (force) {
        const existing = read(dedupKey, channelId);
        if (existing && existing.data.postedAt) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
    }

    try {
        fs.writeFileSync(filePath, JSON.stringify({
            title,
            channelId,
            reservedAt: Date.now(),
            heartbeatAt: Date.now(),
            pid: process.pid
        }), { flag: 'wx' });
        auditLog('reserve_posted_marker', `Reserved marker for "${title}" -> channel ${channelId}: success`, {
            title, dedupKey, channelId, markerPath: filePath, force, success: true
        });
        return true;
    } catch (error) {
        const isRace = error.code === 'EEXIST';
        auditLog(
            'reserve_posted_marker',
            `Reserved marker for "${title}" -> channel ${channelId}: failed (${isRace ? 'already reserved/posted' : 'unexpected error'})`,
            {
                title, dedupKey, channelId, markerPath: filePath, force, success: false,
                errorCode: error.code || null, errorMessage: error.message, errorStack: error.stack
            },
            isRace ? 'warn' : 'error'
        );
        if (error.code === 'EEXIST') return false;
        console.error('❌ Unexpected error reserving posted marker:', error);
        return false;
    }
}

// Refresh `heartbeatAt` on an in-flight reservation. No-op if the marker
// is already confirmed, or if the write fails (best-effort — the send
// itself is what matters).
function heartbeat(dedupKey, channelId) {
    try {
        const existing = read(dedupKey, channelId);
        if (!existing || existing.data.postedAt) return;
        fs.writeFileSync(existing.path, JSON.stringify({ ...existing.data, heartbeatAt: Date.now() }));
    } catch (error) {
        console.warn(`⚠️ Could not update reservation heartbeat for key "${dedupKey}" -> ${channelId}:`, error.message);
    }
}

// Finalize a reservation as CONFIRMED. Best-effort — if this fails, the
// post still went out to Discord, we just lost the local proof.
function confirm(dedupKey, channelId, { title = null } = {}) {
    ensureMarkersDir();
    const filePath = markerPathFor(dedupKey, channelId);
    try {
        fs.writeFileSync(filePath, JSON.stringify({
            title, channelId, postedAt: Date.now(), pid: process.pid
        }));
        auditLog('confirm_posted_marker', `Confirmed marker for "${title}" -> channel ${channelId}: success`, {
            title, dedupKey, channelId, markerPath: filePath, success: true
        });
    } catch (error) {
        auditLog('confirm_posted_marker', `Confirmed marker for "${title}" -> channel ${channelId}: failed`, {
            title, dedupKey, channelId, markerPath: filePath, success: false,
            errorMessage: error.message, errorStack: error.stack
        }, 'error');
        console.warn('⚠️ Could not finalize posted marker (post still went out to Discord):', error.message);
    }
}

// Delete a marker outright. Called after a failed send so the slot is
// free again.
function release(dedupKey, channelId, { title = null } = {}) {
    const filePath = markerPathFor(dedupKey, channelId);
    try {
        fs.unlinkSync(filePath);
        auditLog('release_posted_marker', `Released marker for "${title}" -> channel ${channelId}: success`, {
            title, dedupKey, channelId, markerPath: filePath, success: true
        });
    } catch (error) {
        // ENOENT is expected if the slot was already gone.
        const level = error.code === 'ENOENT' ? 'warn' : 'error';
        auditLog('release_posted_marker', `Released marker for "${title}" -> channel ${channelId}: failed`, {
            title, dedupKey, channelId, markerPath: filePath, success: false,
            errorCode: error.code || null, errorMessage: error.message, errorStack: error.stack
        }, level);
    }
}

// If the marker has postedAt, return that timestamp. Otherwise null.
function lastPostedAt(dedupKey, channelId) {
    const m = read(dedupKey, channelId);
    return m && m.data.postedAt ? m.data.postedAt : null;
}

// Is the marker's reservation too old to be trusted? If it has a heartbeat
// newer than STALE_RESERVATION_MS, it's still considered live and this
// returns false. If there's no marker at all, returns false too — the
// caller checks existence separately.
function isStaleReservation(dedupKey, channelId) {
    const m = read(dedupKey, channelId);
    if (!m) return false;
    if (m.data.postedAt) return false;   // already confirmed; not stale
    const lastAlive = m.data.heartbeatAt || m.data.reservedAt || 0;
    return (Date.now() - lastAlive) > STALE_RESERVATION_MS;
}

// Delete marker files whose mtime is older than `retentionMs`. Returns
// count removed. Runs daily from the maintenance sweep.
function cleanupStaleMarkers(retentionMs) {
    ensureMarkersDir();
    let removed = 0;
    let files = [];
    try {
        files = fs.readdirSync(MARKERS_DIR);
    } catch (error) {
        auditLog('marker_cleanup', 'Failed to read markers directory during cleanup', {
            errorMessage: error.message
        }, 'error');
        return 0;
    }
    const cutoff = Date.now() - retentionMs;
    for (const file of files) {
        const filePath = path.join(MARKERS_DIR, file);
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                removed++;
            }
        } catch (e) { /* file may have been removed concurrently — ignore */ }
    }
    if (removed > 0) {
        auditLog('marker_cleanup', `Marker cleanup removed ${removed} marker file(s) older than the retention window`, {
            removed, retentionMs, totalFilesScanned: files.length
        });
    }
    return removed;
}

// Iterate every marker file on disk, yielding { file, data } for each.
// Used by the consistency check and /stats — both need to walk the whole
// directory, but neither owns the marker schema.
function readAll() {
    ensureMarkersDir();
    const out = [];
    let files = [];
    try {
        files = fs.readdirSync(MARKERS_DIR);
    } catch (error) {
        return out;
    }
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(MARKERS_DIR, file), 'utf8');
            out.push({ file, data: JSON.parse(raw) });
        } catch (e) { /* unreadable — skip */ }
    }
    return out;
}

module.exports = {
    MARKERS_DIR,
    RECONCILIATION_MESSAGE_FETCH_LIMIT,
    markerPathFor,
    read,
    reserve,
    heartbeat,
    confirm,
    release,
    lastPostedAt,
    isStaleReservation,
    cleanupStaleMarkers,
    readAll
};
