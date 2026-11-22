'use strict';
// src/scrapers/lib/insta-shortcode.js
// Pure: Instagram shortcode -> media id -> upload timestamp. No I/O.
//
// A shortcode is the media id written in base64url (A-Z a-z 0-9 - _).
// The id's high bits are a millisecond timestamp:
//   ts_ms = (id >> 23) + 1314220021721
// Longer shortcodes (private-account posts) append extra characters after the
// first 11; only the first 11 carry the id.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_EPOCH_MS = 1314220021721n;
const ID_TS_SHIFT = 23n;
const ID_CHARS = 11;
const MIN_PLAUSIBLE_MS = Date.UTC(2010, 9, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

function isValidShortcode(code) {
    return typeof code === 'string' && /^[A-Za-z0-9_-]{5,64}$/.test(code);
}

function shortcodeToMediaId(code) {
    if (!isValidShortcode(code)) return null;
    let id = 0n;
    for (const ch of code.slice(0, ID_CHARS)) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) return null;
        id = (id << 6n) | BigInt(idx);
    }
    return id;
}

// Returns epoch milliseconds, or null if the code does not decode to a
// plausible time (before late 2010, or more than a day in the future).
function decodeShortcodeTimestamp(code, { nowMs = Date.now() } = {}) {
    const id = shortcodeToMediaId(code);
    if (id === null) return null;
    const ms = Number((id >> ID_TS_SHIFT) + IG_EPOCH_MS);
    if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS || ms > nowMs + DAY_MS) return null;
    return ms;
}

module.exports = { ALPHABET, IG_EPOCH_MS, isValidShortcode, shortcodeToMediaId, decodeShortcodeTimestamp };
