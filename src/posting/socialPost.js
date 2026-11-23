'use strict';
// Social (Instagram club) posting facade. Webhooks + postItems/refreshClub live here;
// everything else is re-exported from socialClubs/Format/Image/PostsStore/Bridge so importers do not change.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./socialPaths');
const { createStore, clubsStore, normUser, USERNAME_RE } = require('./socialClubs');
const { itemTime, buildPayload, stripEmojis, replaceEmojis, loadEmojiPool, classify, stripWrapper, cleanCaption, sanitizeName } = require('./socialFormat');
const { defaultIo, resolveImage, parseDisplayName, sleep } = require('./socialImage');
const { createPostsStore, postsStore, recordPost } = require('./socialPostsStore');
const { buildEventFromPost, queueItem, bridgeToReview, bridgeId } = require('./socialBridge');
const { enrichForItem } = require('./socialEnrich');
const WEBHOOK_NAME = 'Club';
const MAX_AGE_MS = (Number(process.env.CLUBS_MAX_AGE_HOURS) || 72) * 3600 * 1000;
const PERM_MSG = (where) => `Bot is missing the "Manage Webhooks" permission${where ? ' in ' + where : ''}. Grant it on the clubs channel and retry.`;

// ------------------------------------------------------------ webhooks (one per club)
const hookCache = new Map();
const hookName = (club) => ('Club: ' + club.username).replace(/discord|clyde/gi, '-').slice(0, 80);

async function getWebhook(client, channelId, club, dpBuf, { forceAvatar = false } = {}) {
    const key = channelId + '|' + club.username;
    if (forceAvatar) hookCache.delete(key);
    if (hookCache.has(key)) return hookCache.get(key);
    let channel;
    try { channel = await client.channels.fetch(channelId); }
    catch (e) { throw new Error(`Clubs channel ${channelId} not found or not visible to the bot (check CLUBS_CHANNEL_ID).`); }
    if (!channel) throw new Error(`Clubs channel ${channelId} not found (check CLUBS_CHANNEL_ID).`);
    const isThread = typeof channel.isThread === 'function' && channel.isThread();
    const host = isThread ? channel.parent : channel;
    if (!host || typeof host.fetchWebhooks !== 'function') throw new Error(`Channel ${channelId} cannot hold webhooks (use a text channel).`);
    const perms = host.permissionsFor ? host.permissionsFor(client.user) : null;
    if (!perms || !perms.has('ManageWebhooks')) throw new Error(PERM_MSG('#' + (host.name || host.id)));
    const name = hookName(club);
    let hook;
    try {
        const hooks = await host.fetchWebhooks();
        hook = hooks.find((h) => h.owner && h.owner.id === client.user.id && h.name === name && h.token);
        if (!hook) hook = await host.createWebhook({ name, avatar: dpBuf || undefined, reason: 'Instagram club posts' });
        else if (dpBuf && (forceAvatar || !hook.avatar) && typeof hook.edit === 'function') hook = await hook.edit({ avatar: dpBuf });
    } catch (e) {
        if (e && (e.code === 50013 || e.code === 50001)) throw new Error(PERM_MSG('#' + (host.name || host.id)));
        throw e;
    }
    const entry = { hook, threadId: isThread ? channel.id : undefined };
    hookCache.set(key, entry);
    return entry;
}

async function defaultSenderFor(client, channelId, club, dpBuf) {
    let entry = await getWebhook(client, channelId, club, dpBuf);
    const doSend = (payload) => entry.hook.send(entry.threadId ? { ...payload, threadId: entry.threadId } : payload);
    return {
        get avatarURL() { return (typeof entry.hook.avatarURL === 'function' ? entry.hook.avatarURL() : null) || undefined; },
        async send(payload) {
            try { return await doSend(payload); }
            catch (e) {
                if (e && e.code === 10015) { // webhook deleted: rebuild once
                    hookCache.delete(channelId + '|' + club.username);
                    entry = await getWebhook(client, channelId, club, dpBuf);
                    return doSend(payload);
                }
                throw e;
            }
        }
    };
}

// ------------------------------------------------------------ markers
function loadMarkers() {
    const hits = [];
    (function walk(dir) {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
            const p = path.join(dir, d.name);
            if (d.isDirectory()) walk(p);
            else if (d.name === 'markers.js') hits.push(p);
        }
    })(path.join(ROOT, 'src'));
    if (hits.length !== 1) throw new Error('Expected exactly one src/**/markers.js, found ' + hits.length + ': ' + hits.join(', '));
    return require(hits[0]);
}

const explain = (e) => (e && (e.code === 50013 || e.code === 50001)) ? PERM_MSG('') : String((e && e.message) || e);

function clubFor(item, clubs) {
    const cands = [item.username, item.handle, item.account, item.profile, typeof item.club === 'string' ? item.club : null,
        (String(item.title || '').match(/^@?([a-z0-9._]{1,30}):\s/i) || [])[1]].map(normUser).filter(Boolean);
    for (const c of cands) { const hit = clubs.find((x) => x.username === c); if (hit) return hit; }
    if (clubs.length === 1) return clubs[0];
    const u = cands[0];
    return u ? { username: u, label: u, enabled: true } : { username: 'club', label: 'Club', enabled: true };
}

// ------------------------------------------------------------ posting
async function postItems(client, items, opts = {}) {
    const res = { posted: 0, skipped: 0, stale: 0, failed: 0, noImage: 0, errors: [] };
    if (opts.bot) res.queued = 0;
    const list = (items || []).filter(Boolean);
    if (!list.length) return res;
    const channelId = opts.channelId || process.env.CLUBS_CHANNEL_ID;
    if (!channelId) throw new Error('CLUBS_CHANNEL_ID is not set in .env.');
    const now = opts.now || Date.now();
    const maxAge = opts.maxAgeMs === undefined ? MAX_AGE_MS : opts.maxAgeMs;
    const delayMs = opts.delayMs === undefined ? 400 : opts.delayMs;
    const force = opts.force === undefined ? /^(1|true|yes)$/i.test(String(process.env.CLUBS_FORCE_REPOST || '')) : !!opts.force;
    const io = opts.io || defaultIo;
    const clubs = (opts.clubs || clubsStore.list()).filter((c) => c.enabled !== false);
    const senderFor = opts.senderFor || ((club, dpBuf) => defaultSenderFor(client, channelId, club, dpBuf));

    const fresh = [];
    for (const it of list) {
        const t = itemTime(it);
        if (t && now - t > maxAge) res.stale++; else fresh.push(it);
    }
    if (!fresh.length) return res;

    const markers = opts.markers || loadMarkers();
    const senders = new Map();

    for (const it of fresh) {
        const key = it.dedupKey || it.id || it.shortcode || it.url || it.link;
        if (!key) { res.failed++; res.errors.push('item without dedupKey/id/url'); continue; }
        const base = clubFor(it, clubs);
        let sender = senders.get(base.username);
        if (!sender) { // permission errors surface here, before any reserve
            try {
                const dpBuf = await io.getDp(base.username);
                sender = await senderFor(base, dpBuf);
                senders.set(base.username, sender);
            } catch (e) { res.failed++; res.errors.push(explain(e)); continue; }
        }
        const club = { ...base, displayName: base.displayName || (io.getName && io.getName(base.username)) || null };
        if (!markers.reserve(key, channelId, { title: it.title || null, force })) { res.skipped++; continue; }
        const enr = await enrichForItem(it, io, opts);
        try {
            const img = enr && enr.bytes ? { buf: enr.bytes, step: 'enrich', failed: [] } : await resolveImage(it, io);
            if (!img.buf) { res.noImage++; console.warn(`[social-post] no image for ${key}: ${img.failed.join(' | ') || 'no sources'}`); }
            else if (img.failed.length) console.warn(`[social-post] image for ${key} via ${img.step} after: ${img.failed.join(' | ')}`);
            await sender.send(buildPayload(it, { club, image: img.buf ? { buf: img.buf } : null, avatarURL: sender.avatarURL }));
        } catch (e) {
            try { markers.release(key, channelId); } catch (_) { /* best effort */ }
            res.failed++; res.errors.push(explain(e));
            continue;
        }
        try { markers.confirm(key, channelId); } catch (e) { console.warn('[social-post] confirm failed for', key, e.message); }
        const pstore = opts.postsStore || postsStore;
        try { recordPost(enr && enr.title ? Object.assign({}, it, { linkTitle: enr.title }) : it, club, pstore); } catch (e) { console.warn('[social-post] posts.json write failed for', key, e.message); }
        // website clubs feed: fire-and-forget, never blocks or fails the Discord post (off unless WEBSITE_CLUBS_SYNC_ENABLED)
        if (/^(1|true|yes|on)$/i.test(String(process.env.WEBSITE_CLUBS_SYNC_ENABLED || ''))) {
            try { require('../integrations/websiteSync/clubsOps').fireAndForget(it, club); } catch (e) { console.warn('[social-post] website clubs hook failed for', key, e.message); }
        }
        if (opts.bot) {
            try { if (queueItem(opts.bot, it, pstore) === 'queued') res.queued++; }
            catch (e) { console.warn('[social-post] queue to review failed for', key, e.message); }
        }
        res.posted++;
        if (delayMs) await sleep(delayMs);
    }
    return res;
}

// Re-run DP + display-name fetch for one club; push the DP to its webhook avatar.
async function refreshClub(client, username, opts = {}) {
    const io = opts.io || defaultIo;
    const u = normUser(username);
    const out = { displayName: null, dpBytes: 0, webhook: null, errors: [] };
    const r = await io.refreshProfile(u);
    out.displayName = r.displayName; out.dpBytes = r.dp ? r.dp.length : 0; out.errors.push(...r.errors);
    const channelId = opts.channelId || process.env.CLUBS_CHANNEL_ID;
    if (r.dp && channelId && client) {
        try {
            const club = (opts.clubs || clubsStore.list()).find((c) => c.username === u) || { username: u, label: u };
            await getWebhook(client, channelId, club, r.dp, { forceAvatar: true });
            out.webhook = 'avatar updated';
        } catch (e) { out.errors.push('webhook: ' + explain(e)); }
    }
    return out;
}

module.exports = {
    postItems, refreshClub, buildPayload, recordPost, createPostsStore, postsStore, buildEventFromPost, bridgeToReview, queueItem, bridgeId, stripEmojis, replaceEmojis, loadEmojiPool, classify, resolveImage, stripWrapper, cleanCaption, sanitizeName, parseDisplayName,
    getWebhook, itemTime, createStore, clubsStore, normUser, USERNAME_RE, MAX_AGE_MS, WEBHOOK_NAME,
    _resetCache: () => hookCache.clear()
};
