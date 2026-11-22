'use strict';
// posts.json store: shortcode -> saved post record.
const fs = require('fs');
const { writeJsonAtomic } = require('../core/jsonStore');
const { POSTS_FILE } = require('./socialPaths');
const { clip, isHttp, itemTime } = require('./socialFormat');

// Posts store: shortcode -> saved post record (feeds the /pending bridge).
const POSTS_MAX = 400;
const POSTS_MAX_AGE_MS = 60 * 24 * 3600 * 1000;

// shortcode -> { club, label, caption, hints, url, image, postedAt, savedAt, bridged }
function createPostsStore({ file = POSTS_FILE } = {}) {
    function read() {
        if (!fs.existsSync(file)) return {};
        const o = JSON.parse(fs.readFileSync(file, 'utf8')); // corrupt -> throws, never overwritten
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('posts file is not an object: ' + file);
        return o;
    }
    function write(o) { writeJsonAtomic(file, o, { newline: true }); }
    return {
        file,
        get(sc) { try { return read()[sc] || null; } catch (e) { return null; } },
        put(sc, rec) {
            const o = read();
            o[sc] = rec;
            const now = Date.now();
            const keys = Object.keys(o).filter((k) => k === sc || now - (o[k].savedAt || 0) <= POSTS_MAX_AGE_MS);
            keys.sort((a, b) => (o[b].savedAt || 0) - (o[a].savedAt || 0));
            const next = {};
            for (const k of keys.slice(0, POSTS_MAX)) next[k] = o[k];
            write(next);
        },
        markBridged(sc) {
            const o = read();
            if (!o[sc]) return false;
            o[sc].bridged = true;
            write(o);
            return true;
        }
    };
}
const postsStore = createPostsStore();

function recordPost(item, club, store = postsStore) {
    const sc = item && item.shortcode;
    if (!sc || !/^[\w-]+$/.test(sc)) return false;
    const thumb = item.thumbnailUrl || item.thumb || item.thumbnail;
    store.put(sc, {
        club: club.username,
        label: club.displayName || club.label || club.username,
        caption: clip(item.caption || item.description || item.text || item.title || '', 2000),
        hints: item.hints || null,
        ...(item.linkTitle ? { linkTitle: clip(String(item.linkTitle), 200) } : {}),
        url: item.url || item.link || null,
        image: isHttp(thumb) ? thumb : null,
        postedAt: itemTime(item) || null,
        savedAt: Date.now(),
        bridged: false
    });
    return true;
}

module.exports = { createPostsStore, postsStore, recordPost };
