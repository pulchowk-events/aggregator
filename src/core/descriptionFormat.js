// src/core/descriptionFormat.js
// Render-time, rule-based tidy-up for job descriptions. Pure and idempotent: the stored
// description is never modified. Text that already has line structure only gets whitespace cleanup.
'use strict';

const ABBR = ['e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'incl.', 'Sr.', 'Jr.', 'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'No.', 'Inc.', 'Ltd.', 'Pvt.', 'Co.'];
const LIST_HEADINGS = ['Key Responsibilities', 'Job Responsibilities', 'Responsibilities', 'Job Requirements', 'Requirements', 'Qualifications', 'Required Skills', 'Preferred Skills', 'Nice to Have', 'Skills', 'Benefits', 'What We Offer'];
const PROSE_HEADINGS = ['About the Role', 'About Us', 'Job Description', 'Overview'];
const ALL = LIST_HEADINGS.concat(PROSE_HEADINGS).sort((a, b) => b.length - a.length);
const HEAD_RE = new RegExp('(?:^|(?<=[.!?])\\s+)(' + ALL.map((s) => s.replace(/ /g, '\\s+')).join('|') + ')(?::)?(?=\\s+[A-Z0-9])', 'g');

function clean(t) {
    return t.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isStructured(t) {
    return /\n\s*[-\u2022*]\s+\S/.test(t) || (t.match(/\n/g) || []).length >= 3;
}

function bulletize(item) {
    const s = item.trim();
    const m = s.match(/^([A-Za-z][A-Za-z\/&+ -]{1,30}):\s+(\S[\s\S]*)$/);
    if (m && m[1].trim().split(/\s+/).length <= 4) return '- **' + m[1].trim() + ':** ' + m[2].trim();
    return '- ' + s;
}

function formatDescription(raw) {
    try {
        if (typeof raw !== 'string' || !raw.trim()) return raw;
        let t = clean(raw);
        if (isStructured(t)) return t;
        t = t.replace(/\b([A-Za-z][A-Za-z\/]{2,24}):(?=[A-Z][a-z])/g, '$1: ');

        if (t.includes('\u2022')) {
            const parts = t.split(/\s*\u2022\s*/);
            const intro = parts[0].trim();
            const items = parts.slice(1).map((s) => s.trim()).filter(Boolean);
            if (items.length >= 2) return (intro ? intro + '\n\n' : '') + items.map(bulletize).join('\n');
            return t;
        }

        let p = t;
        for (const a of ABBR) p = p.split(a).join(a.replace(/\./g, '\u0001'));
        let found = false;
        p = p.replace(HEAD_RE, (m, name) => { found = true; return '\u0002' + name.replace(/\s+/g, ' ') + '\u0003'; });
        if (!found) return t;

        const seg = p.split(/\u0002([^\u0003]+)\u0003/);
        const out = [];
        if (seg[0].trim()) out.push(seg[0].trim());
        for (let i = 1; i < seg.length; i += 2) {
            const name = seg[i];
            const body = (seg[i + 1] || '').trim();
            let block = '**' + name + '**';
            if (body) {
                if (LIST_HEADINGS.indexOf(name) !== -1) {
                    const sents = body.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
                    block += '\n' + sents.map((s) => '- ' + s).join('\n');
                } else {
                    block += '\n' + body;
                }
            }
            out.push(block);
        }
        return out.join('\n\n').replace(/\u0001/g, '.');
    } catch (e) {
        return raw;
    }
}

module.exports = { formatDescription };
