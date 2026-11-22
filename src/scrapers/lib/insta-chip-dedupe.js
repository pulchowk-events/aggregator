'use strict';
// src/scrapers/lib/insta-chip-dedupe.js
// Pure render-time helpers for Instagram /pending items. A value shown as a chip is not shown again
// in the description or in another embed field. Never touches the stored caption or stored fields. ASCII-only source.

const STRIP_KEYS = new Set(['register', 'location', 'phone', 'teamSize', 'college', 'organizer', 'level', 'prize', 'price', 'audience']);
const URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*/gi;
const PHONE_RUN_RE = /\+?\d[\d\s().-]{6,17}\d/g;

function normText(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function normUrl(u) {
    return String(u == null ? '' : u).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
        .replace(/[?#].*$/, '').replace(/[.,;:!?)\]]+$/, '').replace(/\/+$/, '');
}
function normPhone(s) { return String(s == null ? '' : s).replace(/\D/g, '').replace(/^(?:00)?977/, '').replace(/^0/, ''); }
const wordCount = (s) => normText(s).split(' ').filter(Boolean).length;

function rulesFor(chips) {
    return (chips || []).filter((c) => c && c.value && STRIP_KEYS.has(c.key)).map((c) => ({
        url: c.key === 'register' ? normUrl(c.value) : null,
        digits: c.key === 'phone' ? normPhone(c.value) : null,
        text: normText(c.value)
    }));
}

function lineMatches(line, rules) {
    const t = String(line).trim();
    if (!t) return false;
    for (const r of rules) {
        if (r.url) {
            const us = t.match(URL_RE) || [];
            if (us.some((u) => normUrl(u) === r.url)) {
                let rest = t; us.forEach((u) => { rest = rest.split(u).join(' '); });
                if (wordCount(rest) <= 3) return true;
            }
            continue;
        }
        if (r.digits) {
            const runs = t.match(PHONE_RUN_RE) || [];
            if (runs.some((x) => normPhone(x) === r.digits)) {
                let rest = t; runs.forEach((x) => { rest = rest.split(x).join(' '); });
                if (wordCount(rest) <= 4) return true;
            }
            continue;
        }
        if (!r.text) continue;
        if (normText(t) === r.text) return true;
        const m = /^[^:]{1,30}:[\s:-]*(.+)$/.exec(t);
        if (m && normText(m[1]) === r.text) return true;
    }
    return false;
}

// Remove the lines whose payload is a rendered chip value. A line that carries other content is kept.
function stripChipLines(description, chips) {
    const d = String(description == null ? '' : description);
    const rules = rulesFor(chips);
    if (!d || !rules.length) return d;
    return d.split('\n').filter((l) => !lineMatches(l, rules)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Instagram pending items only; every other source returns null / the original description.
function igChipsOf(event) {
    if (!event || !String(event.source || '').startsWith('instagram-')) return null;
    const ch = event.fields && event.fields.chips;
    return Array.isArray(ch) ? ch.slice(0, 3) : null;
}
function igDescription(event) {
    const base = (event && event.description) || 'No description';
    const chips = igChipsOf(event);
    if (!chips || !chips.length) return base;
    return stripChipLines(event.description || '', chips) || 'No description';
}

// The register link is shown once: drop any other embed field that repeats the register chip URL.
function dropUrlDupes(fields, chips) {
    const reg = (chips || []).find((c) => c && c.key === 'register' && c.value);
    if (!reg || !Array.isArray(fields)) return fields;
    const u = normUrl(reg.value);
    for (let i = fields.length - 1; i >= 0; i--) {
        const f = fields[i];
        if (!f) continue;
        if (f.name === reg.label && String(f.value) === String(reg.value)) continue;
        if ((String(f.value).match(URL_RE) || []).some((x) => normUrl(x) === u)) fields.splice(i, 1);
    }
    return fields;
}

module.exports = { normText, normUrl, normPhone, stripChipLines, igChipsOf, igDescription, dropUrlDupes };
