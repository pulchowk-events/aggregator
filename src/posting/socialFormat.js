'use strict';
// Pure formatting: caption cleanup, emoji handling, title emoji, webhook payload builder.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./socialPaths');
const MAX_CONTENT = 2000;
const SUPPRESS_EMBEDS = 4;

// ------------------------------------------------------------ text helpers
function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

function itemTime(item) {
    const v = item.postedAt || item.date || item.timestamp || item.takenAt || item.takenMs;
    if (!v) return 0;
    if (v instanceof Date) return v.getTime() || 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
}

// Webhook usernames: no "clyde"/"discord", 2..80 chars, no control chars.
function sanitizeName(s) {
    let n = String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/discord|clyde/gi, '-').replace(/\s+/g, ' ').trim();
    n = n.slice(0, 80).trim();
    return n.length >= 2 ? n : 'Club';
}
const cleanTitle = (t) => String(t == null ? '' : t).replace(/[\[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

// Strip Instagram wrappers: `N likes, M comments - user on Date: "caption"`,
// `user on Instagram: "caption"`, and a leading `user: `.
function stripWrapper(text, username) {
    let s = String(text == null ? '' : text).trim();
    const pats = [
        /^[\d,.KkMm]+ likes?, [\d,.KkMm]+ comments? - [\w.]+ on [^:]{1,40}:\s*/,
        /^[\w.]+ on Instagram:\s*/i
    ];
    let wrapped = false;
    for (const p of pats) if (p.test(s)) { s = s.replace(p, ''); wrapped = true; break; }
    if (wrapped) s = s.replace(/^["\u201C]/, '').replace(/["\u201D]\.?\s*$/, '');
    if (username) s = s.replace(new RegExp('^@?' + username.replace(/\./g, '\\.') + ':\\s*', 'i'), '');
    return s.trim();
}

// Caption -> body text: wrapper off, trailing SEO block off, hashtag-only lines off,
// every bare URL wrapped in <> so Discord cannot unfurl it.
function cleanCaption(raw, username) {
    let s = stripWrapper(raw, username).replace(/\r/g, '');
    for (let i = 0; i < 2; i++) {
        const m = s.match(/\s*\[([^\[\]]*)\]\s*$/);
        if (!m) break;
        const inner = m[1];
        const seo = /^\s*(\.{2,}|\u2026)?\s*$/.test(inner) || (inner.match(/#\w+/g) || []).length >= 3 || (inner.match(/,/g) || []).length >= 5;
        if (!seo) break;
        s = s.slice(0, m.index);
    }
    s = s.split('\n').filter((l) => {
        const t = l.trim();
        return !t || !t.split(/\s+/).every((w) => /^#\S+$/.test(w));
    }).join('\n');
    s = s.replace(/(?<!<)https?:\/\/[^\s<>]+/g, (u) => {
        const tail = (u.match(/[.,;:!?)\]]+$/) || [''])[0];
        return '<' + u.slice(0, u.length - tail.length) + '>' + tail;
    });
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------ emoji handling
// ASCII-only source: Unicode property escapes, no literal emoji.
const MOD = '[\\u{1F3FB}-\\u{1F3FF}\\uFE0F]';
const PICT = '(?![\\u00A9\\u00AE\\u2122])\\p{Extended_Pictographic}';
const EMO_SRC = '(?:\\p{Regional_Indicator}{2}|' + PICT + MOD + '*(?:\\u200D' + PICT + MOD + '*)*[\\u{E0020}-\\u{E007F}]*)';
const EMO_G = new RegExp(EMO_SRC, 'gu');
const RUN_G = new RegExp('(?:' + EMO_SRC + '[ \\t]*){3,}', 'gu');
const KEYCAP_G = /([0-9#*])\uFE0F?\u20E3/gu;
const STRAY_G = /[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu; // never strips ZWJ/ZWNJ (Devanagari uses them)
const TOKEN_G = /<a?:\w+:\d+>/g;
const TOKEN_ONLY = /^<a?:\w+:\d+>$/;

// Unicode emoji (code point) -> custom emoji NAMES, first one present in the pool wins.
const UMAP = {};
const U = (names, ...cps) => { for (const c of cps) UMAP[c] = names; };
U(['9455yellowcrown', '5055goldendiamond'], 0x1F3C6, 0x1F451, 0x1F947);
U(['5038redfire'], 0x1F525);
U(['wumpusjumping'], 0x1F389, 0x1F38A, 0x1F973);
U(['purplestar'], 0x2728, 0x2B50, 0x1F31F, 0x1F4AB);
U(['paimonthink'], 0x1F4A1, 0x1F914);
U(['heart'], 0x2764, 0x1F9E1, 0x1F49B, 0x1F49A, 0x1F499, 0x1F49C, 0x1F5A4);
U(['heartpink'], 0x1F497, 0x1F496, 0x1F495, 0x1F493, 0x1F498, 0x1F48C);
U(['heartwhite'], 0x1F90D);
U(['heartache'], 0x1F494);
U(['coin'], 0x1F4B0, 0x1F4B5, 0x1F4B8, 0x1FA99, 0x1F911);
U(['thanksboss'], 0x1F44F, 0x1F64F);
U(['gurawaveback'], 0x1F44B);
U(['73288animatedarrowred'], 0x1F517, 0x27A1, 0x1F449, 0x1F4CD, 0x1F4CC);
U(['education'], 0x1F393, 0x1F4DA, 0x1F4D6);
U(['67197redtick', 'passed'], 0x2705, 0x2714, 0x2611);
U(['laughinghard'], 0x1F602, 0x1F923);
U(['3124_cry'], 0x1F62D, 0x1F622);
U(['thumbsupmeme'], 0x1F44D);
U(['82062flyingheartsredx04'], 0x1F60D, 0x1F970);

function hash32(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
function rngFor(seed) {
    let a = hash32(String(seed));
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let poolCache = null;
// { title: [tokens], desc: [tokens], byName: {name: token} } from src/config/emojis.js
function loadEmojiPool() {
    if (poolCache) return poolCache;
    const byName = {}; const all = [];
    try {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'config', 'emojis.js'), 'utf8');
        for (const m of src.match(TOKEN_G) || []) {
            const name = m.split(':')[1];
            if (!byName[name]) { byName[name] = m; all.push(m); }
        }
    } catch (e) { /* no pool */ }
    let title = []; let desc = [];
    try {
        const e = require('../config/emojis');
        const f = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => TOKEN_ONLY.test(x)) : []);
        title = f(e.TITLE_EMOJIS); desc = f(e.DESCRIPTION_EMOJIS);
    } catch (e) { /* use scanned tokens */ }
    poolCache = { title: title.length ? title : all, desc: desc.length ? desc : all, byName };
    return poolCache;
}

// Remove every emoji (unicode + custom tokens); digits, # and * stay.
function stripEmojis(s) {
    return String(s == null ? '' : s).replace(TOKEN_G, '').replace(KEYCAP_G, '$1').replace(EMO_G, '').replace(STRAY_G, '').replace(/[ \t]{2,}/g, ' ').trim();
}

// Unicode emoji -> custom tokens (mapped, else seeded random from the description pool).
// Runs are collapsed to max 2; existing <:name:id> tokens are left alone.
function replaceEmojis(text, { seed = '', pool } = {}) {
    pool = pool || loadEmojiPool();
    const rnd = rngFor(seed + ':desc');
    const rand = () => (pool.desc.length ? pool.desc[Math.floor(rnd() * pool.desc.length)] : '');
    const lookup = (m) => {
        const names = UMAP[m.codePointAt(0)];
        if (names) for (const n of names) if (pool.byName[n]) return pool.byName[n];
        return rand();
    };
    return String(text == null ? '' : text).split(/(<a?:\w+:\d+>)/).map((p, i) => {
        if (i % 2) return p;
        p = p.replace(KEYCAP_G, '$1').replace(RUN_G, (run) => (run.match(EMO_G) || []).slice(0, 2).join('') + ((/[ \t]+$/.exec(run) || [''])[0]));
        return p.replace(EMO_G, lookup).replace(STRAY_G, '');
    }).join('');
}

const CATS = [
    ['hackathon', /hackathon|hackfest|codefest|datathon|ideathon/i],
    ['exhibition', /exhibition|\bexpo\b|showcase/i],
    ['competition', /competition|contest|championship|tournament|\bquiz\b|\bleague\b|\bcup\b/i],
    ['workshop', /workshop|seminar|bootcamp|webinar|training|masterclass/i],
    ['greeting', /birthday|\bhappy\b|greetings?|congratulations?|congrats|best wishes|festival|dashain|tihar|new year|anniversary/i],
    ['spotlight', /spotlight|\bfeaturing\b|\balumni\b|\binterview\b/i]
];
// hints.type first, then keywords in the caption.
function classify(item) {
    const t = item && item.hints && item.hints.type;
    const texts = [typeof t === 'string' ? t : '', String((item && (item.caption || item.description || item.text || item.title)) || '')];
    for (const s of texts) for (const [cat, re] of CATS) if (re.test(s)) return cat;
    return null;
}
// Names that do not fit a post title (sad/angry/arrows/gestures/placeholder).
const TITLE_DENY = /nocat|cry|sob|sad|angry|rage|skull|dead|poop|vomit|laugh|heartache|broken|thumbs|wave|coin|arrow/i;
const tokName = (t) => String(t).split(':')[1] || '';
const titleOk = (t) => TOKEN_ONLY.test(String(t || '')) && !TITLE_DENY.test(tokName(t));
function pickTitleEmoji(item, pool, seed) {
    let arr = (pool.title || []).filter(titleOk);
    if (!arr.length) arr = (pool.desc || []).filter(titleOk);
    if (!arr.length) { // empty/denied pool: fall back to src/config/emojis.js
        const real = loadEmojiPool();
        arr = real.title.filter(titleOk);
        if (!arr.length) arr = real.desc.filter(titleOk);
    }
    return arr.length ? arr[Math.floor(rngFor(seed + ':title')() * arr.length)] : '';
}

// ------------------------------------------------------------ payload (pure)
// image: { buf } | null.  Plain message, NO embeds, title is NOT linked.
function buildPayload(item, { club = {}, image, avatarURL, emojis } = {}) {
    const pool = emojis || loadEmojiPool();
    const handle = club.username || '';
    const label = club.label || handle || 'Club';
    const username = sanitizeName(club.displayName || club.label || (handle ? '@' + handle : 'Club'));
    const url = item.url || item.link;
    const seed = String(item.shortcode || item.dedupKey || item.id || url || '');
    const hinted = item.hints && item.hints.title;
    let body = cleanCaption(item.caption || item.description || item.text || '', handle);
    if (!body && item.title) body = cleanCaption(item.title, handle);
    const firstLine = body.split('\n').find((l) => l.trim()) || '';
    const title = clip(cleanTitle(stripEmojis(hinted || '')) || cleanTitle(stripEmojis(firstLine)) || `${label} on Instagram`, 200);

    // do not repeat the title in the body
    const lines = body.split('\n');
    const idx = lines.findIndex((l) => l.trim());
    if (idx >= 0 && cleanTitle(stripEmojis(lines[idx])).toLowerCase() === title.toLowerCase()) { lines.splice(idx, 1); body = lines.join('\n').trim(); }
    // body emojis are preserved byte-for-byte (no replaceEmojis on the body path)

    const ts = itemTime(item);
    const kind = (String(item.kind || item.type || item.mediaType || '') + ' ' + (url || '')).toLowerCase();
    const type = /reel/.test(kind) ? 'Reel' : 'Post';
    const em = pickTitleEmoji(item, pool, seed);
    const head = `## ${em ? em + '  ' : ''}${title}\n** **\n`;
    const meta = (ts ? `**Posted:** <t:${Math.floor(ts / 1000)}:D>   ` : '') + `**Type:** ${type}`;
    const link = isHttp(url) ? `\n**Link:** [View on Instagram](<${url}>)` : '';
    const foot = `${meta}${link}\n** **`;

    const budget = MAX_CONTENT - head.length - foot.length - 2;
    if (body.length > budget) {
        body = body.slice(0, Math.max(0, budget - 1));
        body = body.replace(/[\uD800-\uDBFF]$/, '').replace(/\u200D$/, ''); // no split surrogate / dangling ZWJ
        const lt = body.lastIndexOf('<');
        if (lt > body.lastIndexOf('>')) body = body.slice(0, lt); // never leave a half-open <url or <:emoji
        body = body.trimEnd() + '\u2026';
    }
    const content = head + (body ? body + '\n\n' : '') + foot;

    const payload = { username, content, allowedMentions: { parse: [] }, flags: SUPPRESS_EMBEDS };
    if (avatarURL) payload.avatarURL = avatarURL;
    if (image && image.buf) payload.files = [{ attachment: image.buf, name: 'post.' + sniffExt(image.buf) }];
    return payload;
}

function sniffExt(buf) {
    if (buf && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf && buf[0] === 0x52 && buf[1] === 0x49) return 'webp';
    return 'jpg';
}

module.exports = { clip, isHttp, itemTime, sanitizeName, cleanTitle, stripWrapper, cleanCaption, stripEmojis, replaceEmojis, loadEmojiPool, classify, buildPayload };
