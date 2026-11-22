'use strict';
// src/scrapers/lib/insta-seen-store.js
// Per-profile "which shortcodes have we already looked at" tracking, plus a
// tiny global state file (session-dead / challenge-cooldown stamps).
//
// This is NOT markers.js. markers = "was this posted to channel X"; seeding or
// seen-tracking through it would write fake "posted" markers and confuse the
// Discord reconciliation. markers stay reserved for the post stage (S4/S5).
//
// Layout (all under data/instagram/, gitignored with the cookies):
//   seen/<username-lowercase>.json   { username, seen: [codes], lastFetchedAt }
//   state.json                       { sessionDeadAt?, challengeCooldownUntil? }
//
// A missing OR corrupt seen file reads as exists:false -> the caller treats it
// as a cold start (seed, return nothing). That is the safe direction: worst
// case we skip posts, never re-post old ones.

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..', 'data', 'instagram');
const MAX_SEEN = 500;
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// Order-preserving union, oldest dropped past `max`.
function addSeen(existing, codes, max = MAX_SEEN) {
    const out = [];
    const have = new Set();
    for (const c of [].concat(existing || [], codes || [])) {
        if (typeof c !== 'string' || !c || have.has(c)) continue;
        have.add(c);
        out.push(c);
    }
    return out.length > max ? out.slice(out.length - max) : out;
}

function isDue(rec, nowMs, minIntervalMs) {
    if (!rec || !rec.exists || !rec.lastFetchedAt) return true;
    const t = Date.parse(rec.lastFetchedAt);
    if (Number.isNaN(t)) return true;
    return (nowMs - t) >= minIntervalMs;
}

function createSeenStore({ rootDir = DEFAULT_ROOT } = {}) {
    const seenDir = path.join(rootDir, 'seen');
    const stateFile = path.join(rootDir, 'state.json');

    function seenFile(username) {
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            throw new Error('invalid instagram username: ' + JSON.stringify(username));
        }
        return path.join(seenDir, username.toLowerCase() + '.json');
    }

    function load(username) {
        const file = seenFile(username);
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (e) {
            return { exists: false, corrupt: false, username, seen: [], lastFetchedAt: null };
        }
        try {
            const j = JSON.parse(raw);
            if (!j || !Array.isArray(j.seen)) throw new Error('bad shape');
            return {
                exists: true,
                corrupt: false,
                username,
                seen: j.seen.filter((c) => typeof c === 'string'),
                lastFetchedAt: typeof j.lastFetchedAt === 'string' ? j.lastFetchedAt : null
            };
        } catch (e) {
            return { exists: false, corrupt: true, username, seen: [], lastFetchedAt: null };
        }
    }

    function save(username, { seen, lastFetchedAt }) {
        const file = seenFile(username);
        writeJsonAtomic(file, {
            username: username.toLowerCase(),
            seen: addSeen([], seen),
            lastFetchedAt: lastFetchedAt || new Date().toISOString()
        });
        return file;
    }

    function readState() {
        try {
            const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
        } catch (e) {
            return {};
        }
    }

    // null/undefined values delete the key.
    function patchState(patch) {
        const next = Object.assign({}, readState());
        for (const k of Object.keys(patch || {})) {
            if (patch[k] === null || patch[k] === undefined) delete next[k];
            else next[k] = patch[k];
        }
        writeJsonAtomic(stateFile, next);
        return next;
    }

    return { rootDir, seenDir, stateFile, load, save, readState, patchState, isDue };
}

module.exports = { createSeenStore, addSeen, isDue, MAX_SEEN, USERNAME_RE, DEFAULT_ROOT };
