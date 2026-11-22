'use strict';
// Tracked Instagram clubs store (data/instagram/clubs.json, seeded from src/config/insta-clubs.json).
const fs = require('fs');
const { writeJsonAtomic } = require('../core/jsonStore');
const { CLUBS_FILE, SEED_FILE } = require('./socialPaths');
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

// ------------------------------------------------------------ clubs store
const normUser = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();
const entryName = (e) => normUser(typeof e === 'string' ? e : e && e.username);
const isObj = (e) => e && typeof e === 'object';

function createStore({ file = CLUBS_FILE, seed = SEED_FILE } = {}) {
    function write(list) { writeJsonAtomic(file, list, { newline: true }); }
    function read() {
        if (!fs.existsSync(file)) {
            let list = [];
            try {
                const s = JSON.parse(fs.readFileSync(seed, 'utf8'));
                if (Array.isArray(s)) list = s;
            } catch (e) { /* no usable seed */ }
            write(list);
            return list;
        }
        const list = JSON.parse(fs.readFileSync(file, 'utf8')); // corrupt -> throws, never overwritten
        if (!Array.isArray(list)) throw new Error('clubs file is not an array: ' + file);
        return list;
    }
    return {
        file,
        list() {
            return read().map((e) => ({
                username: entryName(e),
                label: isObj(e) && typeof e.label === 'string' ? e.label : entryName(e),
                displayName: isObj(e) && typeof e.displayName === 'string' && e.displayName ? e.displayName : null,
                enabled: !(isObj(e) && e.enabled === false)
            })).filter((c) => c.username);
        },
        add(username, { label, by } = {}) {
            const u = normUser(username);
            if (!USERNAME_RE.test(u)) throw new Error('Invalid Instagram username (letters, digits, . and _ only, max 30).');
            const list = read();
            const i = list.findIndex((e) => entryName(e) === u);
            if (i >= 0) {
                const e = list[i];
                if (isObj(e) && e.enabled === false) { e.enabled = true; write(list); return { status: 'reenabled', username: u }; }
                return { status: 'exists', username: u };
            }
            list.push({ username: u, label: label || u, addedBy: by || null, addedAt: new Date().toISOString() });
            write(list);
            return { status: 'added', username: u };
        },
        update(username, patch) {
            const u = normUser(username);
            const list = read();
            const i = list.findIndex((e) => entryName(e) === u);
            if (i < 0) return false;
            const cur = isObj(list[i]) ? list[i] : { username: u };
            list[i] = { ...cur, ...patch };
            write(list);
            return true;
        },
        remove(username) {
            const u = normUser(username);
            const list = read();
            const next = list.filter((e) => entryName(e) !== u);
            if (next.length === list.length) return false;
            write(next);
            return true;
        }
    };
}

const clubsStore = createStore();

module.exports = { createStore, clubsStore, normUser, USERNAME_RE };
