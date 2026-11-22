'use strict';
// src/scrapers/lib/insta-detail-parse.js
// Pure: one Instagram post/reel page (HTML string) -> caption / time / media hints.
//
// S2.5 evidence (live pages captured 2026-11-22):
//   - og:description / og:title carry the FULL caption (verified verbatim against
//     the app for one photo post). Format of og:description:
//       '37 likes, 2 comments - locus_ioe on October 18, 2026: "<caption>". '
//   - al:ios:url carries the numeric media id: 'instagram://media?id=<id>'. It equals
//     the shortcode decoded as base64url (verified by hand on 2 pages).
//   - og:url carries the page's own shortcode (used to reject a wrong/redirected page).
//   - twitter:title ends with 'Instagram photo' | 'Instagram reel'.
//   - The page also embeds ~45-48 <script type="application/json"> blobs, three of
//     which mention the post code. WHERE the media node sits was NOT established
//     (key-path walks returned 0 paths), so the JSON path is opportunistic: every
//     node whose code === shortcode is collected, scored and merged.
//
// Caption policy: first NON-truncated og caption wins (verified source). JSON replaces
// it only when og is truncated, or when og is a strict prefix of the JSON caption.
// A plain disagreement is recorded in captionConflict, og still wins.

const { shortcodeToMediaId, decodeShortcodeTimestamp } = require('./insta-shortcode');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeHtmlEntities(value) {
    return String(value).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
        if (body[0] === '#') {
            const cp = (body[1] === 'x' || body[1] === 'X')
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
                try { return String.fromCodePoint(cp); } catch (e) { return whole; }
            }
            return whole;
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
    });
}

// Attribute-aware tag body: quoted values may contain '>'.
const TAG_ATTRS = '((?:[^>"\']|"[^"]*"|\'[^\']*\')*)';

function parseAttrs(attrStr) {
    const out = {};
    const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(attrStr || '')) !== null) {
        const name = m[1].toLowerCase();
        const raw = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
        if (!(name in out)) out[name] = decodeHtmlEntities(raw);
    }
    return out;
}

function collectTags(html, tagName) {
    const out = [];
    const re = new RegExp('<' + tagName + '\\b' + TAG_ATTRS + '>', 'gi');
    let m;
    while ((m = re.exec(html)) !== null) out.push(parseAttrs(m[1]));
    return out;
}

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

function toIsoDate(monthName, day, year) {
    const mo = MONTHS[String(monthName || '').toLowerCase()];
    const d = Number(day);
    const y = Number(year);
    if (!mo || !Number.isInteger(d) || !Number.isInteger(y)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
}

function epochToIso(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n > 1e12 ? n : n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeCaptionText(s) {
    if (typeof s !== 'string') return null;
    const t = s.replace(/\r\n?/g, '\n').trim();
    return t ? t : null;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const looksTruncated = (s) => /(\u2026|\.\.\.)$/.test(s);

// ---- JSON path -------------------------------------------------------------

const MAX_JSON_BYTES = 6 * 1024 * 1024;
const MAX_WALK_NODES = 300000;
const TYPENAME_TO_MEDIA_TYPE = { GraphImage: 1, GraphVideo: 2, GraphSidecar: 8 };

// Only blobs that literally contain `needle` (the shortcode) are JSON.parse'd.
function jsonScriptBlobs(html, needle) {
    const out = { blobs: [], withNeedle: 0, parseFailures: 0 };
    const re = new RegExp('<script\\b' + TAG_ATTRS + '>([\\s\\S]*?)<\\/script>', 'gi');
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        if (!/json/i.test(attrs.type || '')) continue;
        const body = m[2] ? m[2].trim() : '';
        if (!body || body.length > MAX_JSON_BYTES || (body[0] !== '{' && body[0] !== '[')) continue;
        if (needle && body.indexOf(needle) < 0) continue;
        out.withNeedle++;
        try { out.blobs.push(JSON.parse(body)); } catch (e) { out.parseFailures++; }
    }
    return out;
}

function captionTextOf(node) {
    let c = null;
    if (node.caption && typeof node.caption === 'object') c = node.caption.text;
    else if (typeof node.caption === 'string') c = node.caption;
    else if (node.edge_media_to_caption && Array.isArray(node.edge_media_to_caption.edges)) {
        const e = node.edge_media_to_caption.edges[0];
        c = e && e.node && e.node.text;
    }
    return normalizeCaptionText(c);
}

// Every object in `root` whose code/shortcode === code (any depth).
function collectMediaNodes(root, code) {
    const found = [];
    const stack = [root];
    let visited = 0;
    while (stack.length) {
        const n = stack.pop();
        if (n === null || typeof n !== 'object') continue;
        if (++visited > MAX_WALK_NODES) break;
        if (Array.isArray(n)) {
            for (let i = n.length - 1; i >= 0; i--) if (n[i] && typeof n[i] === 'object') stack.push(n[i]);
            continue;
        }
        if (n.code === code || n.shortcode === code) found.push(n);
        for (const k of Object.keys(n)) {
            const v = n[k];
            if (v && typeof v === 'object') stack.push(v);
        }
    }
    return found;
}

// 0 = a bare reference carrying nothing useful.
function scoreMediaNode(n) {
    let s = 0;
    if (n.taken_at !== undefined || n.taken_at_timestamp !== undefined) s += 4;
    if (captionTextOf(n)) s += 4;
    if (n.media_type !== undefined || TYPENAME_TO_MEDIA_TYPE[n.__typename]) s += 1;
    if (n.image_versions2 || n.display_url || n.video_versions || n.video_url ||
        n.carousel_media || n.edge_sidecar_to_children) s += 1;
    return s;
}

function firstImageUrl(node) {
    const c = node && node.image_versions2 && node.image_versions2.candidates;
    if (Array.isArray(c) && c[0] && typeof c[0].url === 'string') return c[0].url;
    return (node && typeof node.display_url === 'string') ? node.display_url : null;
}

function normalizeMediaNode(node) {
    let mediaType = [1, 2, 8].includes(node.media_type) ? node.media_type : (TYPENAME_TO_MEDIA_TYPE[node.__typename] || null);
    const videoUrl = (Array.isArray(node.video_versions) && node.video_versions[0] && node.video_versions[0].url)
        || (typeof node.video_url === 'string' ? node.video_url : null);
    let kids = [];
    if (Array.isArray(node.carousel_media)) {
        kids = node.carousel_media.map((c) => ({
            mediaType: [1, 2].includes(c && c.media_type) ? c.media_type : null,
            url: (c && Array.isArray(c.video_versions) && c.video_versions[0] && c.video_versions[0].url) || firstImageUrl(c)
        }));
    } else if (node.edge_sidecar_to_children && Array.isArray(node.edge_sidecar_to_children.edges)) {
        kids = node.edge_sidecar_to_children.edges.map((e) => {
            const c = (e && e.node) || {};
            return { mediaType: TYPENAME_TO_MEDIA_TYPE[c.__typename] || null, url: c.video_url || c.display_url || null };
        });
    }
    kids = kids.filter((k) => k.url).slice(0, 10);
    if (!mediaType && kids.length > 1) mediaType = 8;
    return {
        caption: captionTextOf(node),
        takenAt: epochToIso(node.taken_at !== undefined ? node.taken_at : node.taken_at_timestamp),
        mediaType,
        productType: typeof node.product_type === 'string' ? node.product_type : null,
        imageUrl: firstImageUrl(node),
        videoUrl,
        children: kids
    };
}

// First non-null value per field, in score order.
function mergeNormalized(list) {
    const merged = { caption: null, takenAt: null, mediaType: null, productType: null, imageUrl: null, videoUrl: null, children: [] };
    for (const n of list) {
        for (const k of ['caption', 'takenAt', 'mediaType', 'productType', 'imageUrl', 'videoUrl']) {
            if (merged[k] === null && n[k] !== null && n[k] !== undefined) merged[k] = n[k];
        }
        if (!merged.children.length && n.children.length) merged.children = n.children;
    }
    return merged;
}

function findBestMedia(blobs, code) {
    const scored = [];
    let order = 0;
    for (const blob of blobs) {
        for (const node of collectMediaNodes(blob, code)) {
            const s = scoreMediaNode(node);
            if (s > 0) scored.push({ node, s, order: order++ });
        }
    }
    scored.sort((a, b) => (b.s - a.s) || (a.order - b.order));
    if (!scored.length) return { merged: null, count: 0 };
    return { merged: mergeNormalized(scored.map((x) => normalizeMediaNode(x.node))), count: scored.length };
}

// Legacy single-root helper: best scoring node, or null.
function findMediaNode(root, code) {
    let best = null;
    for (const node of collectMediaNodes(root, code)) {
        const s = scoreMediaNode(node);
        if (s > 0 && (!best || s > best.s)) best = { node, s };
    }
    return best ? best.node : null;
}

// ---- time cross-check ------------------------------------------------------

// Informational: compares a taken_at ISO string with the time encoded in the shortcode.
// NOTE: the id time and taken_at are not guaranteed to be identical on live data.
function crossCheckTakenAt(takenAtIso, code, { toleranceMs = 1000, nowMs = Date.now() } = {}) {
    const t = Date.parse(takenAtIso);
    const sc = decodeShortcodeTimestamp(code, { nowMs });
    if (!Number.isFinite(t) || !sc) return null;
    const deltaMs = t - sc;
    return { shortcodeIso: new Date(sc).toISOString(), deltaMs, toleranceMs, agrees: Math.abs(deltaMs) <= toleranceMs };
}

// ---- og: path --------------------------------------------------------------

const OG_DESC_RE = /^(?:[\d.,]+[KMkm]?\s+likes?,?\s*)?(?:[\d.,]+[KMkm]?\s+comments?\s*)?(?:[-\u2013\u2014]\s*)?([A-Za-z0-9._]+) on ([A-Z][a-z]+) (\d{1,2}), (\d{4}):\s*["\u201c]([\s\S]*)["\u201d]\.?\s*$/;
const OG_DESC_DATE_RE = /^(?:[\d.,]+[KMkm]?\s+likes?,?\s*)?(?:[\d.,]+[KMkm]?\s+comments?\s*)?(?:[-\u2013\u2014]\s*)?([A-Za-z0-9._]+) on ([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/;
const OG_TITLE_RE = / on Instagram:\s*["\u201c]([\s\S]*)["\u201d]\s*$/;

function parseOgDescription(desc) {
    if (typeof desc !== 'string') return null;
    const s = desc.trim();
    let m = OG_DESC_RE.exec(s);
    if (m) return { username: m[1], date: toIsoDate(m[2], m[3], m[4]), caption: normalizeCaptionText(m[5]) };
    m = OG_DESC_DATE_RE.exec(s);
    if (m) return { username: m[1], date: toIsoDate(m[2], m[3], m[4]), caption: null };
    return null;
}

function parseOgTitle(title) {
    if (typeof title !== 'string') return null;
    const m = OG_TITLE_RE.exec(title.trim());
    return m ? normalizeCaptionText(m[1]) : null;
}

function readMetaTags(html) {
    const out = {};
    for (const a of collectTags(html, 'meta')) {
        const key = String(a.property || a.name || '').toLowerCase();
        if (key && a.content !== undefined && !(key in out)) out[key] = a.content;
    }
    return out;
}

// ---- entry point -----------------------------------------------------------

function emptyResult() {
    return {
        caption: null, captionSource: null, captionTruncated: false,
        captionConflict: false, captionUpgradedFromJson: false,
        takenAt: null, takenDate: null, takenAtCheck: null,
        mediaType: null, productType: null, socialKind: null,
        thumbnailUrl: null, imageUrl: null, videoUrl: null,
        children: [],
        username: null, pageCode: null, codeMismatch: false,
        mediaId: null, mediaIdMatchesShortcode: null,
        found: { json: false, og: false },
        diag: { jsonBlobsWithCode: 0, jsonParseFailures: 0, jsonNodes: 0, ogDescriptionParsed: false }
    };
}

function parseDetailHtml(html, { code = null, nowMs = Date.now() } = {}) {
    const r = emptyResult();
    if (typeof html !== 'string' || !html) return r;

    const og = readMetaTags(html);
    r.found.og = Object.keys(og).some((k) => k.indexOf('og:') === 0);

    // Page identity: refuse to attribute another post's caption to this shortcode.
    const urlM = /\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(og['og:url'] || '');
    if (urlM) r.pageCode = urlM[1];
    if (code && r.pageCode && r.pageCode !== code) {
        r.codeMismatch = true;
        r.found.og = false;
        return r;
    }

    const desc = parseOgDescription(og['og:description'] !== undefined ? og['og:description'] : og.description);
    r.diag.ogDescriptionParsed = !!desc;
    if (desc) { r.takenDate = desc.date; r.username = desc.username; }
    const titleCaption = parseOgTitle(og['og:title']);

    const tt = /Instagram (photo|reel|video)\s*$/i.exec(og['twitter:title'] || '');
    if (tt) r.socialKind = tt[1].toLowerCase();

    const idM = /^instagram:\/\/media\?id=(\d+)/.exec(og['al:ios:url'] || '');
    if (idM) {
        r.mediaId = idM[1];
        if (code) {
            const expected = shortcodeToMediaId(code);
            if (expected !== null) {
                try { r.mediaIdMatchesShortcode = BigInt(idM[1]) === expected; } catch (e) { /* leave null */ }
            }
        }
    }

    // JSON (opportunistic)
    let json = null;
    if (code) {
        const sc = jsonScriptBlobs(html, code);
        r.diag.jsonBlobsWithCode = sc.withNeedle;
        r.diag.jsonParseFailures = sc.parseFailures;
        const best = findBestMedia(sc.blobs, code);
        r.diag.jsonNodes = best.count;
        if (best.merged) { json = best.merged; r.found.json = true; }
    }

    // Caption choice
    const cands = [];
    if (desc && desc.caption) cands.push({ text: desc.caption, source: 'og-description' });
    if (titleCaption) cands.push({ text: titleCaption, source: 'og-title' });
    const jsonCaption = json ? json.caption : null;
    let chosen = cands.find((c) => !looksTruncated(c.text)) || null;
    if (jsonCaption) {
        if (!chosen) {
            chosen = { text: jsonCaption, source: 'detail-json' };
        } else {
            const a = squash(chosen.text);
            const b = squash(jsonCaption);
            if (a !== b) {
                if (b.length > a.length && b.indexOf(a) === 0) {
                    chosen = { text: jsonCaption, source: 'detail-json' };
                    r.captionUpgradedFromJson = true;
                } else {
                    r.captionConflict = true;
                }
            }
        }
    }
    if (!chosen && cands.length) chosen = cands[0];
    if (chosen) {
        r.caption = chosen.text;
        r.captionSource = chosen.source;
        r.captionTruncated = chosen.source !== 'detail-json' && looksTruncated(chosen.text);
    }

    // Everything else
    if (json) {
        r.takenAt = json.takenAt;
        r.productType = json.productType;
        r.imageUrl = json.imageUrl;
        r.videoUrl = json.videoUrl;
        r.children = json.children;
    }
    r.mediaType = (json && json.mediaType) || ((r.socialKind === 'reel' || r.socialKind === 'video') ? 2 : null);
    if (r.takenAt && code) r.takenAtCheck = crossCheckTakenAt(r.takenAt, code, { nowMs });
    r.thumbnailUrl = r.imageUrl || og['og:image'] || null;
    if (!r.videoUrl) r.videoUrl = og['og:video:secure_url'] || og['og:video:url'] || og['og:video'] || null;
    if (!r.mediaType && r.videoUrl) r.mediaType = 2;
    return r;
}

module.exports = {
    decodeHtmlEntities, parseAttrs, collectTags, toIsoDate, TAG_ATTRS,
    parseOgDescription, parseOgTitle, readMetaTags,
    jsonScriptBlobs, collectMediaNodes, scoreMediaNode, findMediaNode, normalizeMediaNode,
    crossCheckTakenAt,
    parseDetailHtml
};
