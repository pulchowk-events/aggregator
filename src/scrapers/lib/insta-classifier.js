'use strict';
// src/scrapers/lib/insta-classifier.js
// Rule-based classifier: is an Instagram club post an event announcement?
// Pure function: no I/O, no dependencies, no LLM. ASCII-only source.
//
//   classifyPost(post, { nowMs }) ->
//     { is_event, score, reasons, hints: { title, date, deadline, location, link, type } }
//
// Input: post.caption (fallback post.text), optional post.takenAt (ms, seconds or ISO string).
// The og:description wrapper ('37 likes, 2 comments - user on Month D, YYYY: "...".') is stripped
// first; its date is the POST date, used only as a reference time, never as the event date.
// Reference time for year inference and past/future: takenAt, then wrapper date, then opts.nowMs, then now.
//
// Score = BASE + hits, times the single lowest multiplier, clamped to 0..1. is_event = score >= THRESHOLD.
// Known limits: tuned on 12 captions of one account; date / deadline / location / recap / hiring rules are
// exercised by synthetic captions only. Nepali (BS) dates are not parsed. Days are computed in UTC.

const THRESHOLD = 0.5;
const BASE = 0.1;
const DAY_MS = 86400000;
const TYPES = ['hackathon', 'workshop', 'bootcamp', 'competition', 'exhibition', 'seminar', 'festival', 'meetup', 'other'];

// ---------------------------------------------------------------- patterns

const MONTH_INDEX = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
    jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};
const MONTH_SRC = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DATE_A_SRC = '\\b(' + MONTH_SRC + ')\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?[ \\t]+(\\d{4})\\b)?';
const DATE_B_SRC = '\\b(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?(' + MONTH_SRC + ')\\b\\.?(?:,?[ \\t]+(\\d{4})\\b)?';
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DEADLINE_RE = /\b(?:deadline|last (?:date|day)|closes?|closing|due|until|till|before|by)\b\s*(?:is|on|:)?\W*$/i;

// og:description wrapper, e.g.  37 likes, 2 comments - locus_ioe on October 18, 2026: "
const WRAP_RE = /^\s*(?:[\d.,]+[KkMm]?\s+likes?(?:,\s*|\s+))?(?:[\d.,]+[KkMm]?\s+comments?\s+)?-\s+[\w.]+\s+on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}):\s*"/;

const CTA_RE = /\bregister\b|\bregistration\b|\bsign[- ]?up\b|\bapply (?:now|here|by|before|today)\b|\brsvp\b|\benrol(?:l|lment)?\b|\b(?:book|reserve) (?:your|a) (?:seat|spot|slot)\b/i;
const EVENT_NOUN_RE = /\b(?:exhibition|expo|workshop|hackathon|ideathon|datathon|codeathon|buildathon|competition|contest|olympiad|tournament|seminar|webinar|bootcamp|boot camp|summit|conference|fest|festival|carnival|talk|session|meetup|meet-up|orientation|induction|masterclass|lecture|panel|ctf|quiz|training|cup|challenge|demo day|networking|fair)\b/i;
const ANNOUNCE_RE = /\b(?:is live|are live|now live|now open|open now|registrations? (?:is |are )?open|calling (?:all|for)|invites?|join us|don'?t miss|save the date|stay tuned|coming soon|be there|announcing|we are (?:excited|thrilled|happy|pleased) to)\b/i;
const PRIZE_RE = /\bprizes?\b|\bprize pool\b|\bfree (?:entry|registration|of charge)\b|\bcertificates?\b|\bentry fee\b|\bregistration fee\b|\btickets?\b|\bRs\.?\s?\d|\bNPR\s?\d/i;
const PARTICIPATE_RE = /\bshowcase your\b|\bsubmit your\b|\bcompete\b|\bteams? of \d|\bopen to (?:all|everyone|anyone)\b|\banyone interested\b|\ball students\b|\bparticipate\b/i;
const CONTACT_RE = /\bfor (?:more )?(?:info|information|queries|inquiries|enquiries|details)\b|\bcontact\b|\bwhatsapp\b/i;
const LINK_IN_BIO_RE = /\blink in (?:the |my |our )?bio\b/i;

const GREETING_RE = /\bhappy (?:birthday|bday|new year|dashain|tihar|diwali|holi|teej|christmas|eid|anniversary)\b|\bmany happy returns\b|\bbirthday\b|\bcongratulations?\b|\bcongrats\b|\bwishing (?:you|our|everyone|all)\b|\bcondolences?\b|\brest in peace\b|\bbest wishes\b/i;
const HIRING_RE = /\bwe(?:'re| are) hiring\b|\bnow hiring\b|\bvacanc(?:y|ies)\b|\bjoin our team\b|\brecruit(?:ing|ment)?\b|\binternships?\b|\bjob opening\b|\bapply for the (?:position|role|post)\b/i;
const RECAP_RES = [
    /\bthank(?:s| you)\b/i,
    /\bwas a (?:huge |great |grand |big |major |wonderful )?success\b/i,
    /\bwere a (?:huge |great )?success\b/i,
    /\bsuccessfully (?:held|concluded|completed|organi[sz]ed|conducted|hosted)\b/i,
    /\b(?:has|have) (?:been )?(?:concluded|ended)\b/i,
    /\bwrapped up\b/i, /\bglimpses?\b/i, /\brecap\b/i, /\bthrowback\b/i, /\btbt\b/i, /\bflashback\b/i,
    /\b(?:last|previous) (?:week|month|year)\b/i, /\byesterday\b/i, /\b(?:days?|weeks?|months?) ago\b/i,
    /\bhad the pleasure\b/i, /\b(?:was|were) held\b/i, /\btook place\b/i, /\bhighlights? (?:from|of)\b/i
];
// Participant-feature templates: every regex in a tuple must match. Add one tuple per club template.
const SPOTLIGHT_TEMPLATES = [
    [/\bproject name\s*:/i, /\bteam id\s*:/i]
];

const TYPE_DEFS = [
    ['hackathon', /\b(?:hackathon|ideathon|datathon|codeathon|buildathon)\b/i],
    ['workshop', /\b(?:workshop|masterclass|hands-on|training)\b/i],
    ['bootcamp', /\bboot ?camp\b/i],
    ['competition', /\b(?:competition|contest|olympiad|tournament|challenge|quiz|ctf|cup)\b/i],
    ['exhibition', /\b(?:exhibition|expo|demo day|fair)\b/i],
    ['seminar', /\b(?:seminar|webinar|talk|session|panel|lecture|conference|summit|keynote)\b/i],
    ['festival', /\b(?:festival|fest|carnival)\b/i],
    ['meetup', /\b(?:meet-?up|networking|orientation|induction|get-together)\b/i]
];

const URL_RES = [
    /\bhttps?:\/\/[^\s<>"')\]]+/,
    /\b(?:bit\.ly|tinyurl\.com|forms\.gle|linktr\.ee|lnkd\.in|t\.ly|rb\.gy|cutt\.ly|lu\.ma|forms\.office\.com)\/[^\s<>"')\]]+/,
    /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?/,
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|np|io|ai|dev|app|co|me)\/[^\s<>"')\]]+/
];
const IG_HOST_RE = /\b(?:instagram\.com|instagr\.am|ig\.me)\b/i;
const KNOWN_HOST_RE = /^https?:\/\/(?:bit\.ly|tinyurl\.com|forms\.gle|linktr\.ee|lnkd\.in|t\.ly|rb\.gy|cutt\.ly|lu\.ma|forms\.office\.com|docs\.google\.com\/forms|[^\/]*eventbrite\.com|[^\/]*typeform\.com)/i;
const REG_LINE_RE = /regist|apply|sign[- ]?up|rsvp|enrol|ticket|\bform\b/i;

const LOC_LABEL_RE = /^(?:venue|location|where|place|address)\s*:\s*(.{2,80})$/i;
const ONLINE_RE = /\b(?:via|on|through)\s+(zoom|google meet|microsoft teams|ms teams)\b/i;
const ONLINE_NAMES = { 'zoom': 'Zoom', 'google meet': 'Google Meet', 'microsoft teams': 'Microsoft Teams', 'ms teams': 'MS Teams' };

// ---------------------------------------------------------------- text preparation

function pickCaption(post) {
    if (typeof post === 'string') return post.trim() ? post : '';
    if (post && typeof post === 'object') {
        if (typeof post.caption === 'string' && post.caption.trim()) return post.caption;
        if (typeof post.text === 'string' && post.text.trim()) return post.text;
    }
    return '';
}

function stripWrapper(raw) {
    const m = WRAP_RE.exec(raw);
    if (!m) return { text: raw, postedMs: null };
    const mi = MONTH_INDEX[m[1].toLowerCase()];
    const postedMs = mi === undefined ? null : Date.UTC(Number(m[3]), mi, Number(m[2]));
    return { text: raw.slice(m[0].length).replace(/"\s*\.?\s*$/, ''), postedMs };
}

function cleanLines(text) {
    let s = String(text)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\r/g, '')
        .replace(/[^\x00-\x7F]/g, '');
    s = s.trim().replace(/\[[^\]]*\]\s*$/, ''); // trailing SEO keyword block
    return s.split('\n')
        .map((l) => l.replace(/[ \t]+/g, ' ').trim())
        .filter((l) => l && !/^(?:#\w+\s*)+$/.test(l));
}

function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- title

function truncate(t, max) {
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut) + '...';
}

function deriveTitle(lines) {
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].replace(/[#@]\S+/g, '').trim();
        if (stripped.length < 6) continue;
        let t = lines[i];
        if (i > 0) {
            const s = /^(.+?[.!?:])(?:\s|$)/.exec(t);
            if (s) t = s[1];
        }
        return truncate(t, 100);
    }
    return null;
}

// ---------------------------------------------------------------- dates

function validDay(y, m, d) {
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    const t = Date.UTC(y, m, d);
    const dt = new Date(t);
    if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return Math.floor(t / DAY_MS);
}

function resolveDay(y, m, d, refDay, refYear) {
    if (y !== null) return validDay(y, m, d);
    let day = validDay(refYear, m, d);
    if (day === null) return null;
    if (day < refDay - 14) day = validDay(refYear + 1, m, d);
    return day;
}

const dayToIso = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isDeadline = (before) => DEADLINE_RE.test(before.slice(-45));
const mayOk = (tok) => tok.toLowerCase() !== 'may' || tok === 'May' || tok === 'MAY';

function extractDates(lines, refDay, refYear) {
    const found = [];
    const seen = new Set();
    const add = (day, deadline) => {
        if (day === null || day === undefined) return;
        const key = day + (deadline ? 'd' : 'e');
        if (seen.has(key)) return;
        seen.add(key);
        found.push({ day, deadline });
    };
    lines.forEach((line) => {
        let m;
        const reA = new RegExp(DATE_A_SRC, 'gi');
        while ((m = reA.exec(line))) {
            if (!mayOk(m[1])) continue;
            add(resolveDay(m[3] ? Number(m[3]) : null, MONTH_INDEX[m[1].toLowerCase()], Number(m[2]), refDay, refYear), isDeadline(line.slice(0, m.index)));
        }
        const reB = new RegExp(DATE_B_SRC, 'gi');
        while ((m = reB.exec(line))) {
            if (!mayOk(m[2])) continue;
            add(resolveDay(m[3] ? Number(m[3]) : null, MONTH_INDEX[m[2].toLowerCase()], Number(m[1]), refDay, refYear), isDeadline(line.slice(0, m.index)));
        }
        const reIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
        while ((m = reIso.exec(line))) {
            add(validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])), isDeadline(line.slice(0, m.index)));
        }
        const reDmy = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/g;
        while ((m = reDmy.exec(line))) {
            add(validDay(Number(m[3]), Number(m[2]) - 1, Number(m[1])), isDeadline(line.slice(0, m.index)));
        }
    });
    if (!found.length) {
        const refDow = new Date(refDay * DAY_MS).getUTCDay();
        lines.forEach((line) => {
            let m;
            const reT = /\b(tomorrow|tonight)\b/gi;
            while ((m = reT.exec(line))) {
                add(refDay + (m[1].toLowerCase() === 'tomorrow' ? 1 : 0), isDeadline(line.slice(0, m.index)));
            }
            const reW = /\b(this|next|coming|on)[ \t]+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
            while ((m = reW.exec(line))) {
                let off = (WEEKDAYS[m[2].toLowerCase()] - refDow + 7) % 7;
                if (off === 0 && m[1].toLowerCase() === 'next') off = 7;
                add(refDay + off, isDeadline(line.slice(0, m.index)));
            }
        });
    }
    const future = (arr) => arr.filter((c) => c.day >= refDay).sort((a, b) => a.day - b.day);
    const ev = future(found.filter((c) => !c.deadline))[0];
    const dl = future(found.filter((c) => c.deadline))[0];
    return {
        event: ev ? dayToIso(ev.day) : null,
        deadline: dl ? dayToIso(dl.day) : null,
        allPast: found.length > 0 && !found.some((c) => c.day >= refDay)
    };
}

// ---------------------------------------------------------------- links, location, type

function findLinks(lines) {
    const out = [];
    const seen = new Set();
    lines.forEach((line) => {
        URL_RES.forEach((src) => {
            const re = new RegExp(src.source, 'gi');
            let m;
            while ((m = re.exec(line))) {
                if (m.index > 0 && line[m.index - 1] === '@') continue; // e-mail address
                const url = m[0].replace(/[.,;:!?]+$/, '');
                if (!url || IG_HOST_RE.test(url)) continue;
                const key = url.replace(/^https?:\/\//i, '').toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ url: /^https?:\/\//i.test(url) ? url : 'https://' + url, line });
            }
        });
    });
    return out;
}

function pickLink(links) {
    if (!links.length) return null;
    const reg = links.find((l) => REG_LINE_RE.test(l.line));
    if (reg) return { url: reg.url, kind: 'register' };
    const known = links.find((l) => KNOWN_HOST_RE.test(l.url));
    if (known) return { url: known.url, kind: 'known' };
    return { url: links[0].url, kind: 'other' };
}

function deriveLocation(lines, body) {
    for (const l of lines) {
        const m = LOC_LABEL_RE.exec(l);
        if (m && !/^(?:tba|tbd|tbc)\b/i.test(m[1])) return m[1].trim();
    }
    const o = ONLINE_RE.exec(body);
    if (o) return 'Online (' + (ONLINE_NAMES[o[1].toLowerCase()] || o[1]) + ')';
    return null;
}

function deriveType(title, body) {
    if (title) {
        for (const def of TYPE_DEFS) if (def[1].test(title)) return def[0];
    }
    let best = null;
    for (const def of TYPE_DEFS) {
        const g = new RegExp(def[1].source, 'gi');
        let count = 0;
        let first = -1;
        let m;
        while ((m = g.exec(body))) {
            count++;
            if (first < 0) first = m.index;
        }
        if (count && (!best || count > best.count || (count === best.count && first < best.first))) {
            best = { type: def[0], count, first };
        }
    }
    return best ? best.type : null;
}

// ---------------------------------------------------------------- classify

function emptyResult(reason) {
    return {
        is_event: false,
        score: 0,
        reasons: [reason],
        hints: { title: null, date: null, deadline: null, location: null, link: null, type: null }
    };
}

function classifyPost(post, opts) {
    const o = opts || {};
    const raw = pickCaption(post);
    if (!raw) return emptyResult('empty caption');
    const wrapped = stripWrapper(raw);
    const lines = cleanLines(wrapped.text);
    if (!lines.length) return emptyResult('no text after cleaning');
    const body = lines.join('\n');
    const title = deriveTitle(lines);

    const takenMs = toMs(post && post.takenAt);
    let refMs;
    if (takenMs !== null) refMs = takenMs;
    else if (wrapped.postedMs !== null) refMs = wrapped.postedMs;
    else refMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const refDay = Math.floor(refMs / DAY_MS);
    const refYear = new Date(refDay * DAY_MS).getUTCFullYear();

    const dates = extractDates(lines, refDay, refYear);
    const link = pickLink(findLinks(lines));
    const linkInBio = LINK_IN_BIO_RE.test(body);
    const location = deriveLocation(lines, body);

    const hiring = HIRING_RE.test(body);
    const greeting = GREETING_RE.test(body);
    const recap = RECAP_RES.some((re) => re.test(body));
    const spotlight = SPOTLIGHT_TEMPLATES.some((tpl) => tpl.every((re) => re.test(body)));
    const cta = !hiring && CTA_RE.test(body);

    let score = BASE;
    const reasons = [];
    const add = (v, why) => { score += v; reasons.push('+' + v.toFixed(2) + ' ' + why); };
    if (cta) add(0.30, 'registration call to action');
    if (title && EVENT_NOUN_RE.test(title)) add(0.25, 'event noun in title');
    else if (EVENT_NOUN_RE.test(body)) add(0.10, 'event noun in body');
    if (ANNOUNCE_RE.test(body)) add(0.15, 'announce phrase');
    if (PRIZE_RE.test(body)) add(0.10, 'prize or fee');
    if (PARTICIPATE_RE.test(body)) add(0.10, 'participation ask');
    if (link && link.kind === 'register') add(0.15, 'register link');
    else if (link) add(0.05, 'other link');
    else if (linkInBio) add(0.05, 'link in bio');
    if (dates.event) add(0.15, 'future event date');
    if (dates.deadline) add(0.10, 'future deadline');
    if (location) add(0.05, 'location');
    if (CONTACT_RE.test(body)) add(0.05, 'contact line');

    const mults = [];
    if (recap) mults.push(['recap', cta && dates.event ? 0.7 : 0.35]);
    if (dates.allPast) mults.push(['past-dates', 0.5]);
    if (greeting) mults.push(['greeting', 0.3]);
    if (hiring) mults.push(['hiring', 0.4]);
    if (spotlight) mults.push(['spotlight', 0.3]);
    let mult = 1;
    let multName = null;
    mults.forEach((pair) => {
        reasons.push('flag ' + pair[0] + ' (x' + pair[1] + ')');
        if (pair[1] < mult) { mult = pair[1]; multName = pair[0]; }
    });
    if (multName) reasons.push('applied x' + mult + ' ' + multName);

    const finalScore = Math.min(1, Math.max(0, score * mult));
    const isEvent = finalScore >= THRESHOLD - 1e-9;
    return {
        is_event: isEvent,
        score: Math.round(finalScore * 100) / 100,
        reasons,
        hints: {
            title,
            date: dates.event,
            deadline: dates.deadline,
            location,
            link: link ? link.url : null,
            type: isEvent ? (deriveType(title, body) || 'other') : null
        }
    };
}

module.exports = { classifyPost, THRESHOLD, TYPES };
module.exports.helpers = { MONTH_INDEX, MONTH_SRC, validDay, resolveDay, dayToIso, toMs, findLinks };
