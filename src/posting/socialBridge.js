'use strict';
// Instagram post -> /pending review queue bridge.
const { clip, isHttp, cleanTitle, stripWrapper } = require('./socialFormat');
const { postsStore } = require('./socialPostsStore');
const { extractFields, pickChips } = require('../scrapers/lib/insta-fields');
const bridgeId = (shortcode, handle) => 'igrev:' + shortcode + ':' + handle;
const bridgeRow = (cid) => ({ type: 1, components: [{ type: 2, style: 2, label: 'Send to review', custom_id: cid }] });

const MODE_LABEL = { online: 'Online', onsite: 'Onsite', hybrid: 'Hybrid' };
function priceText(p) {
    if (p === 0) return 'Free';
    if (typeof p === 'number') return 'Rs. ' + p;
    if (typeof p === 'string' && p) return /^\d/.test(p) ? 'Rs. ' + p : p;
    return null;
}
function normRegUrl(u) {
    if (!isHttp(u)) return null;
    try {
        const x = new URL(u);
        const keep = [];
        x.searchParams.forEach((v, k) => { if (!/^(?:utm_|fbclid|igshid)/i.test(k)) keep.push(k + '=' + v); });
        return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (keep.length ? '?' + keep.join('&') : '');
    } catch (e) { return null; }
}
// Same normalized registration link as an existing pending Instagram item: only that item's deadline is refreshed.
function dupByRegUrl(c, ev) {
    const key = normRegUrl(ev.registrationUrl);
    if (!key || !String(ev.source || '').startsWith('instagram-')) return null;
    const hit = (c.pendingEvents || []).find((e) => e && e.id !== ev.id && String(e.source || '').startsWith('instagram-') && normRegUrl(e.registrationUrl) === key);
    if (!hit) return null;
    let updated = false;
    if (ev.deadline && hit.deadline !== ev.deadline) { hit.deadline = ev.deadline; updated = true; }
    return { id: hit.id, updated };
}

function buildEventFromPost(rec, shortcode) {
    const h = rec.hints || {};
    const handle = rec.club || '';
    const desc = clip(stripWrapper(rec.caption || '', handle).replace(/\n{3,}/g, '\n\n'), 1500);
    const first = desc.split('\n').find((l) => l.trim()) || '';
    const title = clip(cleanTitle(h.title || rec.linkTitle || first) || ((rec.label || handle) + ' on Instagram'), 200);
    // hints win; extractFields reads the caption itself and fills only what is still null
    let f = null;
    try { f = extractFields(rec.caption || '', { nowMs: Date.now(), takenAt: rec.postedAt || null, handle }); }
    catch (e) { console.warn('[social-bridge] extractFields failed:', e.message); }
    const m = (f && f.meta) || {};
    const date = h.date ? String(h.date) : ((f && f.date) || null);
    const location = h.location ? String(h.location) : ((f && f.location) || null);
    const reg = isHttp(h.link) ? h.link : ((f && f.registrationUrl) || null);
    const ev = {
        id: 'ig_' + shortcode,
        title,
        description: desc || null,
        image: isHttp(rec.image) ? rec.image : null,
        location,
        date,
        price: f ? priceText(f.price) : null,
        status: null,
        url: isHttp(rec.url) ? rec.url : null,
        registrationUrl: reg,
        organizer: (f && f.organizer) || rec.label || handle || null,
        source: 'instagram-' + handle,
        attendanceMode: f && f.mode ? (MODE_LABEL[f.mode] || null) : null,
        featured: null,
        firstSeenAt: Date.now()
    };
    if (f && f.time) ev.time = f.time;
    if (f && f.endDate && !h.date) ev.endDate = f.endDate;
    if (f && f.deadline) ev.deadline = f.deadline;
    if (f) {
        ev.fields = {
            deadline: f.deadline, endDate: f.endDate, prize: f.prize, audience: f.audience, teamSize: f.teamSize, college: f.college, phone: f.phone, tags: (m.tags || []).slice(),
            chips: pickChips(Object.assign({}, f, { date, location, registrationUrl: reg }), (typeof h.type === 'string' && h.type) || null, Date.now())
        };
    }
    const warn = [];
    if (!date && !(f && f.deadline) && !m.dateFound) warn.push('Instagram: no date found in caption');
    if (!location && !(f && f.mode === 'online')) warn.push('Instagram: no location found in caption');
    if (m.bsFailed) warn.push('Instagram: BS date could not be converted');
    if (m.nonContiguous) warn.push('Instagram: non-contiguous dates in caption, kept first and last');
    if (m.weekdayMismatch) warn.push('Instagram: weekday in caption does not match the date');
    (m.tags || []).forEach((t) => {
        if (t === 'recruitment') warn.push('Instagram: tagged recruitment (call for team or volunteers) - reviewer decides');
        if (t === 'stale') warn.push('Instagram: tagged stale - every date in the caption is before the post date');
    });
    if (!date && !(f && f.deadline) && !reg) warn.push('Instagram: no date, deadline or registration link - check this post by hand');
    if (warn.length) ev.dataQualityWarnings = warn;
    return ev;
}

// Auto-queue a just-posted item into /pending (same event shape + dedup as the button).
function queueItem(bot, item, store = postsStore) {
    const sc = item && item.shortcode;
    if (!sc) return 'skip';
    const rec = store.get(sc);
    if (!rec) return 'skip';
    const ev = buildEventFromPost(rec, sc);
    const c = bot.cache;
    c.pendingEvents = c.pendingEvents || [];
    const known = [].concat(c.pendingEvents, c.postedEvents || [], c.skippedEvents || []);
    if (rec.bridged || known.some((e) => e && e.id === ev.id)) return 'dup';
    const dupHit = dupByRegUrl(c, ev);
    if (dupHit) { try { store.markBridged(sc); } catch (e) { /* best effort */ } bot.saveCache(); return 'dup'; }
    if (typeof bot.sanitizeEventFields === 'function') bot.sanitizeEventFields(ev);
    c.pendingEvents.push(ev);
    try { store.markBridged(sc); } catch (e) { console.warn('[social-post] markBridged failed for', sc, e.message); }
    bot.saveCache();
    return 'queued';
}

// Button click (admin gate already applied by handleButton). All state changes happen before the reply.
async function bridgeToReview(bot, interaction, opts = {}) {
    const store = opts.store || postsStore;
    const reply = (content) => interaction.reply({ content, flags: 64 });
    const m = /^igrev:([\w-]+):([a-z0-9._]{1,30})$/.exec(String(interaction.customId || ''));
    if (!m) return reply('Unknown Instagram review button.');
    const rec = store.get(m[1]);
    if (!rec || rec.club !== m[2]) return reply('Post data expired; use /club fetch again.');
    const ev = buildEventFromPost(rec, m[1]);
    const c = bot.cache;
    c.pendingEvents = c.pendingEvents || [];
    const known = [].concat(c.pendingEvents, c.postedEvents || [], c.skippedEvents || []);
    if (rec.bridged || known.some((e) => e && e.id === ev.id)) return reply('Already in review or handled.');
    const dupHit = dupByRegUrl(c, ev);
    if (dupHit) { bot.saveCache(); return reply('Same registration link is already in review' + (dupHit.updated ? '; its deadline was updated.' : '.')); }
    if (typeof bot.sanitizeEventFields === 'function') bot.sanitizeEventFields(ev);
    c.pendingEvents.push(ev);
    try { store.markBridged(m[1]); } catch (e) { console.warn('[social-post] markBridged failed for', m[1], e.message); }
    bot.saveCache();
    const missing = ['date', 'location', 'image'].filter((k) => !ev[k]);
    return reply('Sent "' + ev.title + '" to review (/pending).' + (missing.length ? ' Missing: ' + missing.join(', ') + '.' : ''));
}

module.exports = { buildEventFromPost, queueItem, bridgeToReview, bridgeId };
