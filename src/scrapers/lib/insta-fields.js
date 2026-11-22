'use strict';
// src/scrapers/lib/insta-fields.js
// Pure rule-based field extraction for Instagram club captions. No I/O. ASCII-only source.
//   extractFields(caption, { nowMs, takenAt, handle }) ->
//     { date, endDate, time, deadline, location, price, registrationUrl, mode, organizer, audience, prize, teamSize, college, phone, meta }
// null when unknown, never invented. price: 0 = free, number = Rs, string = per-unit text.
// BS (Nepali) dates go through the single adapter bsToAd(); no other file imports the library.

const _cls = require('./insta-classifier');
if (!_cls.helpers) throw new Error('insta-classifier helpers export missing');
const H = _cls.helpers;
const { stripWrapper } = require('../../posting/socialFormat');
const { parseEventDate } = require('../../core/dateUtils');
const { MONTH_INDEX, MONTH_SRC, validDay, dayToIso, toMs, findLinks } = H;

const DAY = 86400000;

// ------------------------------------------------------------------ BS adapter
let ND = null;
try { const lib = require('nepali-date-converter'); ND = lib.default || lib.NepaliDate || lib; } catch (e) { ND = null; }
const p2 = (n) => String(n).padStart(2, '0');
// bsToAd(2083, 5, 1) -> "2026-08-17". m is 1-based. The library returns LOCAL midnight, so local getters are used (never UTC).
function bsToAd(y, m, d) {
    if (!ND || !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (y < 2000 || y > 2090 || m < 1 || m > 12 || d < 1 || d > 32) return null;
    try {
        const n = new ND(y, m - 1, d);
        if (n.getYear() !== y || n.getMonth() !== m - 1 || n.getDate() !== d) return null; // library rolls invalid days over
        const j = n.toJsDate();
        if (!(j instanceof Date) || Number.isNaN(j.getTime())) return null;
        return j.getFullYear() + '-' + p2(j.getMonth() + 1) + '-' + p2(j.getDate());
    } catch (e) { return null; }
}
const isoToDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? validDay(+m[1], +m[2] - 1, +m[3]) : null; };

const BS_MONTHS = {
    baisakh: 1, baishakh: 1, baisak: 1, jestha: 2, jeth: 2, jyestha: 2, ashadh: 3, asadh: 3, ashad: 3, asar: 3, ashar: 3,
    shrawan: 4, srawan: 4, sawan: 4, saun: 4, bhadra: 5, bhadau: 5, ashwin: 6, aswin: 6, asoj: 6, ashoj: 6,
    kartik: 7, kattik: 7, kartic: 7, mangsir: 8, mangshir: 8, mansir: 8, poush: 9, paush: 9, push: 9, pous: 9,
    magh: 10, maagh: 10, falgun: 11, fagun: 11, phalgun: 11, chaitra: 12, chait: 12
};
const BS_SRC = Object.keys(BS_MONTHS).sort((a, b) => b.length - a.length).join('|');

// ------------------------------------------------------------------ text preparation
const LABEL_EMOJI = [
    [/[\u{1F4C5}\u{1F4C6}\u{1F5D3}]/u, 'Date: '],
    [/[\u{23F0}\u{23F1}\u{23F2}\u{1F550}-\u{1F567}]/u, 'Time: '],
    [/[\u{1F4CD}]/u, 'Venue: '],
    [/[\u{1F4B0}\u{1F4B5}\u{1F4B8}\u{1FA99}]/u, 'Money: '],
    [/[\u{1F3C6}\u{1F947}\u{1F381}]/u, 'Prize: ']
];
const LEAD_RE = /^[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+/u;
const WRAP_DATE_RE = /^\s*[\d.,KkMm]+\s+likes?,\s*[\d.,KkMm]+\s+comments?\s*-\s*[\w.]+\s+on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}):/;
const AGE_RE = /^(\d{1,3})\s?([wdhmy])$/i;

function labelLine(line) {
    const lead = LEAD_RE.exec(line);
    if (!lead) return line;
    if (/^(?:venue|location|where|date|time|when|prize|fee)\s*:/i.test(line.slice(lead[0].length))) return line.slice(lead[0].length);
    for (const [re, label] of LABEL_EMOJI) if (re.test(lead[0])) return label + line.slice(lead[0].length);
    return line;
}

function prepare(raw, o) {
    let text = String(raw);
    let wrapMs = null;
    const w = WRAP_DATE_RE.exec(text);
    if (w) { const mi = MONTH_INDEX[w[1].toLowerCase()]; if (mi !== undefined) wrapMs = Date.UTC(+w[3], mi, +w[2]); }
    text = stripWrapper(text, o.handle || '');
    text = text.replace(/\r/g, '').normalize('NFKC').split('\n').map(labelLine).join('\n');
    text = text.normalize('NFKC')
        .replace(/[\u{2018}\u{2019}]/gu, "'").replace(/[\u{201C}\u{201D}]/gu, '"').replace(/[\u{2013}\u{2014}\u{2212}]/gu, '-').replace(/\u00D7/g, 'x')
        .replace(/[^\x00-\x7F]/g, '');
    text = text.replace(/\s*\[[^\[\]]*,[^\[\]]*(?:\]\s*)?$/, ''); // trailing SEO keyword block (may be cut off)
    const lines = text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l) => l && !/^(?:#\w+\s*)+$/.test(l));
    let ageMs = null;
    if (lines.length && AGE_RE.test(lines[lines.length - 1])) {
        const a = AGE_RE.exec(lines.pop());
        ageMs = Number(a[1]) * ({ w: 7, d: 1, h: 0, m: 0, y: 365 }[a[2].toLowerCase()]) * DAY;
    }
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const takenMs = toMs(o.takenAt);
    let refMs = nowMs; let refFrom = 'now';
    if (takenMs !== null) { refMs = takenMs; refFrom = 'takenAt'; }
    else if (wrapMs !== null) { refMs = wrapMs; refFrom = 'wrapper'; }
    else if (ageMs !== null) { refMs = nowMs - ageMs; refFrom = 'age'; }
    const refDay = Math.floor(refMs / DAY);
    return { lines, nowMs, refDay, refYear: new Date(refDay * DAY).getUTCFullYear(), refFrom };
}

// ------------------------------------------------------------------ dates
const ORD = '(?:st|nd|rd|th)?';
const SEP = '\\s*(?:-|to|until|till)\\s*';
const WD_SRC = '(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?';
const WD_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const wdOf = (s) => WD_IDX[String(s).slice(0, 3).toLowerCase()];
const DL_BEFORE_RES = [
    /\b(?:deadline|last (?:date|day)|clos(?:e|es|ing)|due|until|till|before|by|ends?)\b\s*(?:is|on|:)?\W*$/i,
    /\b(?:close|closes|closing|ends?)\b[^.\n]{0,25}$/i,
    /\b(?:deadline|last (?:date|day)|due date|closing date)\s+(?:to|for|of)\s+[a-z ]{1,25}\s*[:-]?\s*$/i,
    /\b(?:deadline|last (?:date|day)|due date|closing date)\b\s*(?:is|on|:|-)?\s*(?:[A-Za-z']+\s+){0,3}\(?\s*$/i
];
const NEW_DL_RE = /\b(?:new|extended|revised|updated)\s+(?:registration\s+)?deadline\b|\bdeadline\s+(?:has been\s+)?extended\b/i;

const WDMID = '(?:\\s*[,(]?\\s*' + WD_SRC + '\\s*\\)?)?';
function patternsFor(kind) {
    const M = kind === 'ad' ? '(' + MONTH_SRC + ')' : '(' + BS_SRC + ')';
    const Y = kind === 'ad' ? '(\\d{4})' : '(20\\d\\d)';
    const N = kind === 'ad' ? 2 : 1; // extra numbers needed for a list
    const YO = '(?:,?\\s*' + Y + ')?';
    return [
        ['listMD', new RegExp('\\b' + M + '\\.?\\s+(\\d{1,2}(?:\\s*,\\s*\\d{1,2}){' + N + ',})(?![\\d:])', 'gi')],
        ['listDM', new RegExp('\\b(\\d{1,2}(?:\\s*,\\s*\\d{1,2}){' + N + ',})' + ORD + '\\s+' + M + '\\b', 'gi')],
        ['crossDM', new RegExp('\\b(\\d{1,2})' + ORD + '\\s+' + M + '\\.?' + YO + WDMID + SEP + '(\\d{1,2})' + ORD + '\\s+' + M + '\\.?' + YO, 'gi')],
        ['crossMD', new RegExp('\\b' + M + '\\.?\\s+(\\d{1,2})' + ORD + YO + WDMID + SEP + M + '\\.?\\s+(\\d{1,2})' + ORD + YO, 'gi')],
        ['rngDM', new RegExp('\\b(\\d{1,2})' + ORD + SEP + '(\\d{1,2})' + ORD + '\\s+(?:of\\s+)?' + M + '\\b\\.?' + YO, 'gi')],
        ['rngMD', new RegExp('\\b' + M + '\\.?\\s+(\\d{1,2})' + ORD + SEP + '(\\d{1,2})' + ORD + '(?![\\d:])' + YO, 'gi')],
        ['oneDM', new RegExp('\\b(\\d{1,2})' + ORD + '\\s+(?:of\\s+)?' + M + '\\b\\.?' + YO, 'gi')],
        ['oneMD', new RegExp('\\b' + M + '\\.?\\s+(\\d{1,2})' + ORD + '(?![\\d:])' + YO, 'gi')]
    ];
}
const PATS = { ad: patternsFor('ad'), bs: patternsFor('bs') };

function mIdx(kind, tok) { return kind === 'ad' ? MONTH_INDEX[tok.toLowerCase()] + 1 : BS_MONTHS[tok.toLowerCase()]; }
const okMay = (kind, tok) => kind !== 'ad' || tok.toLowerCase() !== 'may' || tok === 'May' || tok === 'MAY';

// a raw candidate: { kind, idx, end, m, d, y, m2, d2, y2, list, nonContig }
function scanLine(line) {
    const out = []; const used = [];
    const free = (a, b) => !used.some(([x, y]) => a < y && b > x);
    ['ad', 'bs'].forEach((kind) => {
        PATS[kind].forEach(([name, re]) => {
            re.lastIndex = 0;
            let g;
            while ((g = re.exec(line))) {
                const a = g.index; const b = a + g[0].length;
                if (!free(a, b)) continue;
                let c = null;
                const num = (s) => Number(s);
                if (name === 'listMD' || name === 'listDM') {
                    const tok = name === 'listMD' ? g[1] : g[2];
                    if (!okMay(kind, tok)) continue;
                    const nums = (name === 'listMD' ? g[2] : g[1]).split(/\s*,\s*/).map(num);
                    const contig = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
                    c = { m: mIdx(kind, tok), d: nums[0], d2: nums[nums.length - 1], list: nums, nonContig: !contig };
                } else if (name === 'crossDM') {
                    if (!okMay(kind, g[2]) || !okMay(kind, g[5])) continue;
                    c = { d: num(g[1]), m: mIdx(kind, g[2]), y: g[3] ? num(g[3]) : null, d2: num(g[4]), m2: mIdx(kind, g[5]), y2: g[6] ? num(g[6]) : null };
                } else if (name === 'crossMD') {
                    if (!okMay(kind, g[1]) || !okMay(kind, g[4])) continue;
                    c = { m: mIdx(kind, g[1]), d: num(g[2]), y: g[3] ? num(g[3]) : null, m2: mIdx(kind, g[4]), d2: num(g[5]), y2: g[6] ? num(g[6]) : null };
                } else if (name === 'rngDM') {
                    if (!okMay(kind, g[3])) continue;
                    c = { d: num(g[1]), d2: num(g[2]), m: mIdx(kind, g[3]), y: g[4] ? num(g[4]) : null };
                } else if (name === 'rngMD') {
                    if (!okMay(kind, g[1])) continue;
                    c = { m: mIdx(kind, g[1]), d: num(g[2]), d2: num(g[3]), y: g[4] ? num(g[4]) : null };
                } else if (name === 'oneDM') {
                    if (!okMay(kind, g[2])) continue;
                    c = { d: num(g[1]), m: mIdx(kind, g[2]), y: g[3] ? num(g[3]) : null };
                } else {
                    if (!okMay(kind, g[1])) continue;
                    c = { m: mIdx(kind, g[1]), d: num(g[2]), y: g[3] ? num(g[3]) : null };
                }
                if (!c || !c.m) continue;
                c.kind = kind; c.idx = a; c.end = b;
                used.push([a, b]);
                out.push(c);
            }
        });
    });
    // ISO and dd/mm/yyyy
    let g; const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((g = iso.exec(line))) if (free(g.index, g.index + g[0].length)) { used.push([g.index, g.index + g[0].length]); out.push({ kind: 'ad', idx: g.index, end: g.index + g[0].length, m: +g[2], d: +g[3], y: +g[1] }); }
    const dmy = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/g;
    while ((g = dmy.exec(line))) if (free(g.index, g.index + g[0].length)) { used.push([g.index, g.index + g[0].length]); out.push({ kind: 'ad', idx: g.index, end: g.index + g[0].length, m: +g[2], d: +g[1], y: +g[3] }); }
    return out.sort((x, y) => x.idx - y.idx);
}

function weekdayFor(line, c) {
    const before = line.slice(Math.max(0, c.idx - 18), c.idx);
    const b = new RegExp('\\b(' + WD_SRC + ')\\.?,?\\s*(?:the\\s+)?$', 'i').exec(before);
    if (b) return wdOf(b[1]);
    const a = new RegExp('^[\\s,(-]*(' + WD_SRC + ')\\b', 'i').exec(line.slice(c.end, c.end + 24));
    return a ? wdOf(a[1]) : null;
}

// resolve one candidate to { day, endDay, failed, mismatch }
function resolveCand(c, line, ctx) {
    const res = { day: null, endDay: null, failed: false, mismatch: false };
    const wd = weekdayFor(line, c);
    const dayFor = c.kind === 'ad'
        ? (y, m, d) => validDay(y, m - 1, d)
        : (y, m, d) => { const iso = bsToAd(y, m, d); return iso ? isoToDay(iso) : null; };
    const years = c.kind === 'ad'
        ? [ctx.refYear - 1, ctx.refYear, ctx.refYear + 1, ctx.refYear + 2]
        : [ctx.refYear + 55, ctx.refYear + 56, ctx.refYear + 57, ctx.refYear + 58, ctx.refYear + 59];
    let year = null; let day = null;
    if (c.y) { year = c.y; day = dayFor(year, c.m, c.d); }
    else {
        const opts = years.map((y) => ({ y, day: dayFor(y, c.m, c.d) })).filter((x) => x.day !== null);
        let pool = opts;
        if (wd !== null) {
            const hit = opts.filter((x) => new Date(x.day * DAY).getUTCDay() === wd);
            if (hit.length) pool = hit; else res.mismatch = true;
        }
        const ok = pool.filter((x) => x.day >= ctx.refDay - 14).sort((a, b) => a.day - b.day)[0];
        const pick = ok || pool.sort((a, b) => b.day - a.day)[0];
        if (pick) { year = pick.y; day = pick.day; }
    }
    if (day === null) { res.failed = true; return res; }
    if (wd !== null && c.y && new Date(day * DAY).getUTCDay() !== wd) res.mismatch = true;
    res.day = day;
    if (c.d2 || c.m2) {
        const m2 = c.m2 || c.m;
        let y2 = c.y2 || year;
        let e = dayFor(y2, m2, c.d2);
        if (e !== null && e < day && !c.y2) { y2 += 1; e = dayFor(y2, m2, c.d2); }
        if (e !== null && e >= day) res.endDay = e; else res.failed = true;
    }
    return res;
}

const RANGE_SEP_RE = /(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]{3,9}\.?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?)(?:\s*[,(]?\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*\)?)?\s*(?:till|until)\s*$/i;
const isDeadlineAt = (line, c, prevLine) => {
    const before = line.slice(Math.max(0, c.idx - 45), c.idx);
    if (RANGE_SEP_RE.test(before)) return false;
    if (DL_BEFORE_RES.some((re) => re.test(before))) return true;
    if (c.idx <= 2 && prevLine && /\b(?:deadline|last date|apply by|register by|registrations? (?:close|end)|closes?|due)\W*$/i.test(prevLine)) return true;
    return false;
};

// ------------------------------------------------------------------ time
const TZ_RE = /^\s*\(?\s*(UTC|GMT|NPT|NST|IST|EST|EDT|PST|PDT|CET|BST|Nepal Time)\b/i;
function timesIn(line) {
    const out = []; let rest = line; let g;
    const rr = /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/gi;
    const to24 = (h, pm) => (pm ? (h < 12 ? h + 12 : 12) : (h === 12 ? 0 : h));
    while ((g = rr.exec(line))) {
        const h1 = Number(g[1]); const m1 = g[2] ? Number(g[2]) : 0; const h2 = Number(g[3]); const m2 = g[4] ? Number(g[4]) : 0;
        if (h1 < 1 || h1 > 12 || h2 < 1 || h2 > 12 || m1 > 59 || m2 > 59) continue;
        const pm = g[5].toLowerCase() === 'p';
        let st = to24(h1, pm); const en = to24(h2, pm);
        if (st * 60 + m1 > en * 60 + m2) st = to24(h1, !pm);
        const z = TZ_RE.exec(line.slice(g.index + g[0].length));
        out.push({ t: p2(st) + ':' + p2(m1), zone: z ? z[1] : null });
        out.push({ t: p2(en) + ':' + p2(m2), zone: z ? z[1] : null });
        rest = rest.slice(0, g.index) + ' '.repeat(g[0].length) + rest.slice(g.index + g[0].length);
    }
    return out.concat(timesInRaw(rest));
}
function timesInRaw(line) {
    const out = [];
    const re = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/gi;
    let g;
    while ((g = re.exec(line))) {
        let h = Number(g[1]); const mi = g[2] ? Number(g[2]) : 0;
        if (h < 1 || h > 12 || mi > 59) continue;
        if (g[3].toLowerCase() === 'p' && h < 12) h += 12;
        if (g[3].toLowerCase() === 'a' && h === 12) h = 0;
        const z = TZ_RE.exec(line.slice(g.index + g[0].length));
        out.push({ t: p2(h) + ':' + p2(mi), zone: z ? z[1] : null });
    }
    const r24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi;
    while ((g = r24.exec(line))) {
        const z = TZ_RE.exec(line.slice(g.index + g[0].length));
        const labeled = /^(?:time|timing|when|schedule)\s*:/i.test(line);
        if (!z && !labeled && !/\bhrs?\b/i.test(line.slice(g.index + g[0].length, g.index + g[0].length + 6))) continue;
        out.push({ t: p2(Number(g[1])) + ':' + g[2], zone: z ? z[1] : null });
    }
    return out;
}
function pickTime(ts) {
    if (!ts.length) return null;
    const np = ts.find((x) => x.zone && /^(?:NPT|NST|Nepal Time)$/i.test(x.zone));
    const t = np || ts[0];
    return t.zone ? t.t + ' ' + t.zone : t.t;
}

// ------------------------------------------------------------------ links / location / misc
const LINK_DENY_RE = /syllabus|rule ?book|guideline|rules|brochure|discord\.(?:gg|com)|drive\.google|docs\.google\.com\/(?:document|presentation|file|spreadsheets)|notion\.|canva\.com|facebook\.com|youtube\.com|youtu\.be/i;
const REG_LABEL_RE = /regist|apply|sign[- ]?up|rsvp|enrol|join|book|ticket|\bform\b|secure your|grab your/i;
const KNOWN_HOST_RE = /^https?:\/\/(?:bit\.ly|tinyurl\.com|forms\.gle|lnkd\.in|t\.ly|rb\.gy|cutt\.ly|lu\.ma|shorturl\.at|is\.gd|ow\.ly|buff\.ly|short\.io|tiny\.cc|rebrand\.ly|bitly\.com|forms\.office\.com|docs\.google\.com\/forms|[^\/]*eventbrite\.com|[^\/]*typeform\.com)/i;

const SHORT_RE = /(?:^|[^\w@.\/-])((?:shorturl\.at|is\.gd|ow\.ly|buff\.ly|short\.io|tiny\.cc|rebrand\.ly|bitly\.com)\/[^\s<>"')\]]+)/gi;
const FORM_HOST_RE = /^https?:\/\/(?:docs\.google\.com\/forms|forms\.gle|forms\.office\.com|[^\/]*typeform\.com)/i;
const REG_PATH_RE = /\/(?:register|registration|apply|application|signup|sign-up|rsvp|enrol|enroll)/i;
const REG_STRONG_RE = /regist|appl(?:y|ication)|sign[- ]?up|rsvp|enrol|\bseats?\b|\bspots?\b/i;
const REG_LEAD_RE = /regist|appl(?:y|ication)|sign[- ]?up|rsvp|enrol|\bseats?\b|\bspots?\b|\bjoin\b|\bbook\b|ticket|secure your|grab your/i;
const SURVEY_RE = /\b(?:survey|feedback|interests|aspirations|questionnaire|poll)\b/i;

// findLinks results plus scheme-less shortener hosts it does not know, deduped
function allLinks(lines) {
    const out = findLinks(lines).slice();
    const keyOf = (u) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    const seen = new Set(out.map((l) => keyOf(l.url)));
    lines.forEach((line) => {
        const re = new RegExp(SHORT_RE.source, 'gi');
        let m;
        while ((m = re.exec(line))) {
            const rawUrl = m[1].replace(/[.,;:!?]+$/, '');
            if (!rawUrl || seen.has(keyOf(rawUrl))) continue;
            seen.add(keyOf(rawUrl));
            out.push({ url: 'https://' + rawUrl, line });
        }
    });
    return out;
}

function pickRegLink(lines) {
    const body = lines.join('\n');
    let best = null;
    for (const l of allLinks(lines)) {
        const li = lines.indexOf(l.line);
        const prev = li > 0 ? lines[li - 1] : '';
        const prev2 = li > 1 ? lines[li - 2] : '';
        const pos = l.line.indexOf(l.url.replace(/^https?:\/\//, ''));
        const lead = pos > 0 ? l.line.slice(Math.max(0, pos - 30), pos).replace(/https?:\/\/$/, '') : '';
        const shortLead = lead.trim().length < 3;
        const label = lead + ' ' + (shortLead ? prev.slice(-40) : '');
        const noUrl = (x) => x.replace(/https?:\/\/\S+/g, '');
        const wide = lead + ' ' + (shortLead ? noUrl(prev2) + ' ' + noUrl(prev) : '');
        if (LINK_DENY_RE.test(l.url) || LINK_DENY_RE.test(label)) continue;
        if (FORM_HOST_RE.test(l.url)) {
            if (!REG_LEAD_RE.test(wide) && !REG_STRONG_RE.test(body)) continue;
            if (SURVEY_RE.test(lead + ' ' + prev) && !REG_LEAD_RE.test(lead)) continue;
        }
        const score = (REG_LABEL_RE.test(wide) || REG_PATH_RE.test(l.url)) ? 3 : (KNOWN_HOST_RE.test(l.url) ? 2 : 0);
        if (score >= 2 && (!best || score > best.score)) best = { url: l.url, score };
    }
    return best ? best.url : null;
}

const TBA_RE = /\b(?:tba|tbd|tbc|to be (?:announced|decided|confirmed|informed)|will be (?:announced|informed|shared)|announced (?:soon|via|later)|via e-?mail)\b/i;
const PLATFORM_RE = /\b(zoom|google meet|microsoft teams|ms teams|discord|webex)\b/i;
function pickLocation(lines) {
    for (let i = 0; i < lines.length; i++) {
        const m = /^(?:venue|location|where|place|address)\s*:?\s*(.*)$/i.exec(lines[i]);
        if (!m) continue;
        let v = m[1].trim();
        if (!v && lines[i + 1]) v = lines[i + 1].trim();
        v = v.replace(/https?:\/\/\S+/g, '').replace(/^[\s:,-]+|[\s,;|-]+$/g, '').trim();
        if (!v) continue;
        return { raw: v, tba: TBA_RE.test(v), platform: (PLATFORM_RE.exec(v) || [])[1] || null };
    }
    return null;
}

const FREE_RES = [
    /\bfree (?:registration|entry|admission|of cost|of charge|event|workshop|session|to (?:join|attend|participate)|for (?:all|everyone))\b/i,
    /\b(?:it'?s|is|its) free\b/i, /\bno (?:registration |entry |participation )?(?:fee|charge|cost)s?\b/i
];
const PRIZEY_RE = /prize|worth|win\b|reward|cash|pool|giveaway|scholarship/i;
const CUR = '(?:Rs\\.?|NPR|NRs\\.?)?\\s*';
const FEE_RES = [
    new RegExp('\\b(?:registration|entry|participation|commitment|ticket|enrol?l?ment|admission|joining|course|program(?:me)?|workshop)?\\s*(?:fee|fees|cost|charge|price)s?\\s*(?:is|are|of|:|-)?\\s*' + CUR + '([\\d,]+)\\s*(?:\\/-)?\\s*(?:only)?\\s*(per\\s+[a-z]+(?:\\s[a-z]+)?|\\/\\s*[a-z]+|each)?', 'i'),
    new RegExp('(?:Rs\\.?|NPR|NRs\\.?)\\s*([\\d,]+)\\s*(?:\\/-)?\\s*(?:only\\s*)?(?:as\\s+(?:a\\s+)?)?(?:registration|entry|commitment|participation|ticket|joining)\\s*(?:fee|fees)\\b()', 'i'),
    new RegExp('(?:Rs\\.?|NPR|NRs\\.?)\\s*([\\d,]+)\\s*(?:\\/-)?\\s*only\\b()', 'i')
];
function pickPrice(lines) {
    let paid = null;
    for (const l of lines) {
        if (PRIZEY_RE.test(l)) continue;
        for (const re of FEE_RES) {
            const m = re.exec(l);
            if (!m || !m[1]) continue;
            const n = Number(String(m[1]).replace(/,/g, ''));
            if (!Number.isFinite(n) || n <= 0 || /^\d{9,}$/.test(String(m[1]).replace(/,/g, ''))) continue;
            paid = m[2] ? String(n) + ' ' + m[2].replace(/^\//, 'per ').replace(/\s+/g, ' ').trim() : n;
            break;
        }
        if (paid !== null) break;
    }
    const free = lines.some((l) => FREE_RES.some((re) => re.test(l)));
    return { paid, free };
}

const AMT = '(Rs\\.?|NPR|NRs\\.?)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*([KkLl])?\\s*(\\+)?';
const PRIZE_RES = [
    new RegExp(AMT + '\\s*(prize\\s*pool|prize\\s*money|cash\\s*prizes?|in\\s*prizes?|prizes?)\\b', 'i'),
    new RegExp('\\b(?:prize\\s*pool|prize\\s*money|prizes?|rewards?|cash\\s*prizes?)\\s*(?:pool\\s*)?(?:worth|of|:|-)\\s*(?:up to\\s*)?' + AMT + '()', 'i'),
    new RegExp('\\bworth\\s+(?:up to\\s*)?' + AMT + '()', 'i')
];
function fmtAmt(cur, num, k, plus) {
    const c = cur ? (/^npr/i.test(cur) ? 'NPR' : 'Rs') : '';
    return (c ? c + ' ' : '') + num + (k ? k.toUpperCase() : '') + (plus ? '+' : '');
}
function pickPrize(lines) {
    for (const l of lines) {
        for (let i = 0; i < PRIZE_RES.length; i++) {
            const m = PRIZE_RES[i].exec(l);
            if (!m) continue;
            if (!m[2] || /^\d{9,}$/.test(m[2].replace(/,/g, ''))) continue;
            if (!(m[1] || m[3] || /,|\d{4,}/.test(m[2]))) continue; // a bare small number is not a prize amount
            const pool = i === 0 && /pool/i.test(m[5]);
            return { text: fmtAmt(m[1], m[2], m[3], m[4]) + (pool ? ' prize pool' : ''), low: false };
        }
    }
    const g = lines.find((l) => /\b(?:swag|giveaways?|goodies|surprise gifts?|gift hampers?|merch(?:andise)?)\b/i.test(l));
    return g ? { text: 'Gift giveaways', low: true } : null;
}

const SPONSOR_RE = /\b(?:sponsored by|powered by|supported by|in partnership with|presented by our sponsors?)\b/i;
const ORG_RE = /\b(?:co-?organi[sz]ed by|organi[sz]ed by|hosted by|brought to you by|conducted by)\s*:?\s*([^\n.|#\x21]{2,70})/i;
const ORG_WORD = /\b(?:club|society|committee|forum|association|community|lab|cell|union|chapter|team)\b/i;
function pickOrganizer(lines) {
    for (const l of lines) {
        if (SPONSOR_RE.test(l) && !ORG_RE.test(l)) continue;
        const m = ORG_RE.exec(l);
        if (m) {
            const v = m[1].replace(/\s+(?:and|with|in)\s+.*$/i, '').replace(/[\s,;:-]+$/, '').trim();
            if (v.length >= 2) return v.slice(0, 80);
        }
    }
    for (const l of lines) {
        if (SPONSOR_RE.test(l)) continue;
        const m = /\b([A-Z][\w&.']*(?: [A-Z][\w&.']*){0,3}) [xX] ([A-Z][\w&.']*(?: [A-Z][\w&.']*){0,3})\b/.exec(l);
        if (!m) continue;
        const acr = (s) => /^[A-Z]{2,8}$/.test(s);
        if (ORG_WORD.test(m[1]) || ORG_WORD.test(m[2]) || (acr(m[1]) && acr(m[2]))) return (m[1] + ' x ' + m[2]).slice(0, 80);
    }
    return null;
}

const LEVEL_RE = /\bschool|\+2\b|\bbachelor|\bundergrad|\bmaster'?s|\bcollege|\banyone interested|\beveryone\b/i;
function pickAudience(lines) {
    const parts = [];
    for (const l of lines) {
        const a = /\b(?:open to|eligibility|who can (?:join|participate|apply)|for (?:all )?(?:school|\+2|bachelor|undergraduate))\b\s*:?\s*([^\n]{0,90})/i.exec(l);
        if (a) parts.push((a[1] || l).replace(/[\s,;:-]+$/, '').trim() || l);
        else { const n = /\bno prior (?:knowledge|experience)\b[^.\n]{0,20}/i.exec(l); if (n) parts.push(n[0].trim()); }
    }
    if (!parts.length) for (const l of lines) { const segs = l.split(','); if (l.length <= 100 && segs.length >= 3 && segs.filter((x) => LEVEL_RE.test(x)).length >= 2) { parts.push(l.replace(/[\s,;:-]+$/, '')); break; } }
    return parts.length ? parts.join('; ').slice(0, 140) : null;
}

// ------------------------------------------------------------------ team size / college / phone
const TEAM_OF_RE = /\bteams?\s+of\s+(up to\s+|max(?:imum)?\s+)?(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?(?!\d)(?!\s*(?:\w+\s+)?(?:mentors?|experts?|engineers?|professionals?|volunteers?|organi[sz]ers?|judges?|speakers?|instructors?)\b)/i;
const TEAM_SIZE_RE = /\bteam size\s*:?\s*(?:of\s*)?(up to\s+|max(?:imum)?\s+)?(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?(?!\d)/i;
const MEMBERS_RNG_RE = /\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*(?:members?|persons?|people|participants?)\b/i;
const PER_TEAM_RE = /\b(\d{1,2})\s*(?:members?|persons?)\s*(?:per|each|in (?:a|each))\s*team\b/i;
const SOLO_RE = /\b(solo|individual)\s+(?:participation|participants?|entry|only|event|competition)\b|\bparticipat\w*\s+(?:is\s+|are\s+)?(solo|individual)\b/i;
function teamVal(flag, a, b) {
    const x = Number(a);
    if (!(x >= 1 && x <= 20)) return null;
    if (b !== undefined && b !== null && b !== '') { const y = Number(b); return y > x && y <= 20 ? x + '-' + y + ' members' : null; }
    if (flag) return 'Up to ' + x + ' members';
    return x === 1 ? 'Solo' : 'Team of ' + x;
}
function pickTeamSize(lines) {
    const found = [];
    const add = (v) => { if (v && found.indexOf(v) < 0) found.push(v); };
    for (const l of lines) {
        let m;
        if ((m = TEAM_SIZE_RE.exec(l)) || (m = TEAM_OF_RE.exec(l))) { add(teamVal(m[1], m[2], m[3])); continue; }
        if ((m = MEMBERS_RNG_RE.exec(l))) { add(teamVal(null, m[1], m[2])); continue; }
        if ((m = PER_TEAM_RE.exec(l))) { add(teamVal(null, m[1], null)); continue; }
        if ((m = SOLO_RE.exec(l))) { const w = (m[1] || m[2]).toLowerCase(); add(w === 'solo' ? 'Solo' : 'Individual'); }
    }
    return { value: found[0] || null, ambiguous: found.length > 1 };
}

const COLLEGE_STRONG = 'Kathford|Sunway|Herald|Islington|Softwarica|Khwopa|Kantipur|Kathmandu University|Tribhuvan University|Pokhara University|Nepal Engineering';
const COLLEGE_WEAK = 'Pulchowk|Thapathali|Paschimanchal|Purwanchal|Advanced|Patan|Cosmos|Himalaya|Janakpur|Acme|Orchid|Texas';
const COLLEGE_RE = new RegExp('\\b(?:(?:IOE|IoE)[\\s,]+)?(?:(?:' + COLLEGE_STRONG + ')(?:\\s+(?:Engineering\\s+)?(?:Campus|College))?|(?:' + COLLEGE_WEAK + ')\\s+(?:Engineering\\s+)?(?:Campus|College))\\b', 'i');
const COLLEGE_ACR_RE = /\b(?:IOE|NCIT|TU|KU|NEC)\b/;
const COLLEGE_CTX_RE = /\b(?:organi[sz]ed by|hosted by|presented by|open to|eligibility|students (?:of|from))\b|^(?:venue|location|where|place|address)\s*:/i;
const fmtCollege = (s) => s.replace(/\s+/g, ' ').replace(/,/g, '').replace(/\b\w+/g, (w) => (/^ioe$/i.test(w) ? 'IOE' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).trim();
function pickCollege(lines) {
    for (const l of lines) {
        if (!COLLEGE_CTX_RE.test(l)) continue;
        let m = COLLEGE_RE.exec(l);
        if (m) return fmtCollege(m[0]);
        m = COLLEGE_ACR_RE.exec(l);
        if (m) return m[0];
    }
    return null;
}

const PHONE_RUN_RE = /\+?\d[\d\s().-]{6,17}\d/g;
const PHONE_URL_RE = /https?:\/\/\S+|\b[\w.-]+\.[a-z]{2,}\/\S*/gi;
// Nepal numbers: mobile 98XXXXXXXX / 97XXXXXXXX, Kathmandu landline 01-XXXXXXX; +977 / 00977 prefix accepted
function normNpPhone(raw) {
    const d = String(raw).replace(/\D/g, '');
    const r = d.replace(/^(?:00)?977/, '');
    const intl = r.length !== d.length;
    if (/^9[78]\d{8}$/.test(r)) return r;
    if (/^01\d{6,7}$/.test(r) || (intl && /^1\d{6,7}$/.test(r))) return '01-' + r.replace(/^0?1/, '');
    return null;
}
function pickPhone(lines) {
    for (const l of lines) {
        const t = l.replace(PHONE_URL_RE, ' ');
        const re = new RegExp(PHONE_RUN_RE.source, 'g');
        let m;
        while ((m = re.exec(t))) {
            if (/(?:rs\.?|npr|nrs\.?)\s*$/i.test(t.slice(Math.max(0, m.index - 6), m.index))) continue;
            const p = normNpPhone(m[0]);
            if (p) return p;
        }
    }
    return null;
}

const RECRUIT_RE = /\bcall for\b[^\n]{0,40}\b(?:marketing|design(?:er)?s?|volunteers?|event managers?|content|photograph|team|members?)\b|\b(?:looking for|recruiting|we need)\b[^\n]{0,30}\b(?:volunteers?|designers?|marketing team|event managers?)\b|\bvolunteers? (?:needed|wanted)\b/i;
const TYPE_DEFS = [['hackathon', /hackathon|ideathon|datathon|codeathon|code ?jam/i], ['competition', /competition|contest|olympiad|tournament|challenge|ctf|quiz|cup/i], ['exhibition', /exhibition|expo\b|demo day/i], ['workshop', /workshop|bootcamp|masterclass|training/i], ['seminar', /seminar|webinar|talk|session|panel|lecture/i]];
const typeOf = (text) => { for (const [t, re] of TYPE_DEFS) if (re.test(text)) return t; return null; };

// ------------------------------------------------------------------ extractFields
function empty() {
    return { date: null, endDate: null, time: null, deadline: null, location: null, price: null, registrationUrl: null, mode: null, organizer: null, audience: null, prize: null, teamSize: null, college: null, phone: null,
        meta: { dateFound: false, bsFailed: false, nonContiguous: false, weekdayMismatch: false, rolling: false, lastCall: false, stale: false, tags: [], warnings: [], type: null, timeShifts: null, prizeLowRank: false } };
}

function extractFields(caption, opts) {
    const o = opts || {};
    const out = empty();
    if (typeof caption !== 'string' || !caption.trim()) return out;
    let P;
    try { P = prepare(caption, o); } catch (e) { return out; }
    const { lines, refDay } = P;
    if (!lines.length) return out;
    const meta = out.meta;
    const body = lines.join('\n');
    meta.type = typeOf(lines[0] || '') || typeOf(body);

    // ---- dates
    const evs = []; const dls = [];
    lines.forEach((line, li) => {
        const prev = li > 0 ? lines[li - 1] : '';
        const lineNew = NEW_DL_RE.test(line);
        scanLine(line).forEach((c) => {
            meta.dateFound = true;
            const r = resolveCand(c, line, P);
            if (r.mismatch) meta.weekdayMismatch = true;
            if (r.failed || r.day === null) { if (c.kind === 'bs') meta.bsFailed = true; return; }
            if (c.nonContig) meta.nonContiguous = true;
            const dl = isDeadlineAt(line, c, prev);
            const item = { day: r.day, endDay: r.endDay, li, isNew: dl && lineNew };
            (dl ? dls : evs).push(item);
        });
    });
    // relative deadlines resolve against the post date
    if (/\b(?:last call|last chance|final call|closes? (?:today|tonight)|closing (?:today|tonight)|ends? (?:today|tonight)|hurry)\b/i.test(body)) meta.lastCall = true;
    if (/\b(?:closes?|closing|ends?|registrations? (?:close|end|closing))\s+(?:today|tonight)\b|\bonly today\b/i.test(body)) { dls.push({ day: refDay, endDay: null, li: -1, isNew: false }); meta.dateFound = true; }
    const left = /\b(\d{1,2}) days? left\b/i.exec(body);
    if (left) { dls.push({ day: refDay + Number(left[1]), endDay: null, li: -1, isNew: false }); meta.dateFound = true; }
    if (/\b(?:1 day left|one day left|last day)\b/i.test(body) && !left) { dls.push({ day: refDay + 1, endDay: null, li: -1, isNew: false }); meta.dateFound = true; }
    if (/\bdeadline\s*:?\s*rolling\b|\brolling (?:basis|deadline|admissions?)\b/i.test(body)) meta.rolling = true;
    if (!evs.length) { // weekday-relative words, only when there is no explicit event date
        const dow = new Date(refDay * DAY).getUTCDay();
        const rel = new RegExp('\\b(tomorrow|tonight|(?:this|next|coming)\\s+(' + WD_SRC + '))\\b', 'i').exec(body);
        if (rel) {
            meta.dateFound = true;
            if (/^tomorrow/i.test(rel[1])) evs.push({ day: refDay + 1, endDay: null, li: -1 });
            else if (/^tonight/i.test(rel[1]) && !/clos/i.test(body)) evs.push({ day: refDay, endDay: null, li: -1 });
            else if (rel[2]) { let off = (wdOf(rel[2]) - dow + 7) % 7; if (off === 0 && /^next/i.test(rel[1])) off = 7; evs.push({ day: refDay + off, endDay: null, li: -1 }); }
        }
    }
    let ev = evs.filter((e) => e.day >= refDay).sort((a, b) => a.day - b.day)[0];
    if (!ev && evs.length) { ev = evs.slice().sort((a, b) => a.day - b.day)[0]; if (!dls.some((d) => d.day >= refDay)) meta.stale = true; }
    if (ev) {
        const iso = dayToIso(ev.day);
        if (parseEventDate({ date: iso })) out.date = iso; else meta.warnings.push('date failed validation: ' + iso);
        if (ev.endDay !== null && ev.endDay >= ev.day) { const e2 = dayToIso(ev.endDay); if (parseEventDate({ date: e2 })) out.endDate = e2; }
    }
    if (dls.length && (!meta.rolling || dls.some((d) => d.li >= 0))) {
        const newer = dls.filter((d) => d.isNew).sort((a, b) => b.day - a.day)[0];
        const dl = newer || dls.filter((d) => d.day >= refDay - 1).sort((a, b) => a.day - b.day)[0] || dls.slice().sort((a, b) => b.day - a.day)[0];
        const iso = dayToIso(dl.day);
        if (parseEventDate({ date: iso })) {
            const lt = dl.li >= 0 ? pickTime(timesIn(lines[dl.li])) : null;
            out.deadline = lt ? iso + ' ' + lt.split(' ')[0] : iso;
        }
    }

    // ---- time (event lines only; deadline lines keep their own time)
    const dlLine = (l) => /\b(?:deadline|closes?|closing|apply by|register by|last date|due)\b/i.test(l);
    const shifts = [];
    lines.filter((l) => !dlLine(l)).forEach((l) => timesIn(l).forEach((t) => shifts.push(t)));
    out.time = pickTime(shifts);
    const uniq = Array.from(new Set(shifts.map((t) => t.t)));
    if (uniq.length > 1) meta.timeShifts = uniq;

    // ---- location / mode
    const loc = pickLocation(lines);
    const onlineWord = /\bonline\b|\bwebinar\b|\bvirtual(?:ly)?\b|\bvia (?:zoom|google meet|microsoft teams|ms teams)\b|\bon (?:zoom|google meet|microsoft teams)\b/i.test(body);
    const platformOnly = loc && loc.platform && !/\b(?:campus|hall|lab|building|road|street|college|center|centre)\b/i.test(loc.raw);
    if (loc && !loc.tba && !platformOnly) out.location = loc.raw.slice(0, 120);
    if (out.location) out.mode = /\bhybrid\b/i.test(body) ? 'hybrid' : 'onsite';
    else if (platformOnly || onlineWord) out.mode = 'online';
    else if (/\bhybrid\b/i.test(body)) out.mode = 'hybrid';

    // ---- price / prize / link / organizer / audience
    const pr = pickPrice(lines);
    if (pr.paid !== null) { out.price = pr.paid; if (pr.free) meta.warnings.push('both free and paid wording found'); }
    else if (pr.free) out.price = 0;
    const pz = pickPrize(lines);
    if (pz) { out.prize = pz.text; meta.prizeLowRank = pz.low; }
    out.registrationUrl = pickRegLink(lines);
    out.organizer = pickOrganizer(lines);
    out.audience = pickAudience(lines);
    const ts = pickTeamSize(lines);
    out.teamSize = ts.value;
    if (ts.ambiguous) meta.warnings.push('multiple team sizes in caption: kept first');
    out.college = pickCollege(lines);
    out.phone = pickPhone(lines);

    // ---- tags / warnings (tag, never drop)
    if (RECRUIT_RE.test(body)) meta.tags.push('recruitment');
    if (meta.stale) meta.tags.push('stale');
    if (meta.nonContiguous) meta.warnings.push('non-contiguous dates: kept first and last');
    if (meta.weekdayMismatch) meta.warnings.push('weekday in caption does not match the date');
    if (meta.bsFailed) meta.warnings.push('BS date not converted');
    return out;
}

// ------------------------------------------------------------------ chips
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? Number(m[3]) + ' ' + MON3[Number(m[2]) - 1] + ' ' + m[1] : null; }
function fmtRange(a, b) {
    if (!b || b === a) return fmtDay(a);
    const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(a); const y = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
    if (x && y && x[1] === y[1] && x[2] === y[2]) return Number(x[3]) + '-' + Number(y[3]) + ' ' + MON3[Number(x[2]) - 1] + ' ' + x[1];
    return fmtDay(a) + ' - ' + fmtDay(b);
}
const CHIP_PRIZE_TYPES = ['competition', 'hackathon', 'exhibition'];
const RESTRICTIVE_RE = /\b(?:only|limited to|exclusively|members|batch|\d(?:st|nd|rd|th) (?:year|sem))\b/i;

const LEVEL_CHIP_RE = /\bschool|\+2\b|\bbachelor|\bundergrad|\bmaster'?s|\bcollege/i;
const chipNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// up to 3 chips chosen per post; nulls skipped; duplicates dropped; fewer than 3 is fine, never filler.
// rank: last call / deadline, register, date, location, prize, team size, level, price, college, organizer, phone, audience
function pickChips(f, type, nowMs) {
    if (!f || typeof f !== 'object') return [];
    const meta = f.meta || {};
    const t = type || meta.type || null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const c = [];
    if (f.date) c.push({ score: 90, key: 'date', label: 'Date', value: fmtRange(f.date, f.endDate) + (f.time ? ', ' + f.time : '') });
    else if (f.time) c.push({ score: 85, key: 'time', label: 'Time', value: f.time });
    if (f.deadline) {
        const dIso = String(f.deadline).slice(0, 10);
        const dd = isoToDay(dIso);
        const daysAway = dd === null ? null : dd - Math.floor(now / DAY);
        if (daysAway === null || daysAway >= -1) {
            const close = meta.lastCall || (daysAway !== null && daysAway <= 7);
            c.push({ score: close ? 100 : 70, key: 'deadline', label: meta.lastCall ? 'Last call' : 'Deadline', value: fmtDay(dIso) + (String(f.deadline).length > 10 ? ', ' + String(f.deadline).slice(11) : '') });
        }
    }
    if (typeof f.registrationUrl === 'string' && /^https?:\/\//i.test(f.registrationUrl)) c.push({ score: 95, key: 'register', label: 'Register', value: f.registrationUrl });
    let locVal = null;
    if (f.location) { locVal = f.location; c.push({ score: 80, key: 'location', label: 'Location', value: f.location }); }
    else if (f.mode === 'online') { locVal = 'Online'; c.push({ score: 80, key: 'location', label: 'Location', value: 'Online' }); }
    if (f.prize && CHIP_PRIZE_TYPES.indexOf(t) >= 0) c.push({ score: meta.prizeLowRank ? 30 : 66, key: 'prize', label: 'Prize', value: f.prize });
    if (f.teamSize) c.push({ score: 64, key: 'teamSize', label: 'Team', value: f.teamSize });
    if (f.audience && LEVEL_CHIP_RE.test(f.audience)) c.push({ score: 62, key: 'level', label: 'Level', value: f.audience });
    if (f.price === 0) c.push({ score: 60, key: 'price', label: 'Price', value: 'Free' });
    else if (typeof f.price === 'number') c.push({ score: 60, key: 'price', label: 'Price', value: 'Rs ' + f.price });
    else if (typeof f.price === 'string' && f.price) c.push({ score: 60, key: 'price', label: 'Price', value: /^\d/.test(f.price) ? 'Rs ' + f.price : f.price });
    if (f.college) {
        const cn = chipNorm(f.college);
        const inLoc = locVal && chipNorm(locVal).indexOf(cn) >= 0;
        const inOrg = f.organizer && chipNorm(f.organizer).indexOf(cn) >= 0;
        if (!inLoc && !inOrg) c.push({ score: 55, key: 'college', label: 'College', value: f.college });
    }
    if (f.organizer) c.push({ score: 50, key: 'organizer', label: 'Organizer', value: f.organizer });
    if (f.phone) c.push({ score: 45, key: 'phone', label: 'Phone', value: f.phone });
    if (f.audience && !LEVEL_CHIP_RE.test(f.audience) && RESTRICTIVE_RE.test(f.audience) && !/\b(?:anyone|everyone|all)\b/i.test(f.audience)) c.push({ score: 40, key: 'audience', label: 'Open to', value: f.audience });
    const seen = new Set();
    return c.filter((x) => x.value).sort((a, b) => b.score - a.score)
        .filter((x) => { const k = chipNorm(x.value); if (!k || seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 3).map((x) => ({ key: x.key, label: x.label, value: String(x.value).slice(0, 200) }));
}

module.exports = { extractFields, pickChips, _bsToAd: bsToAd };
