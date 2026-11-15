// scripts/batch/lib/anomaly-detect.js
//
// Lightweight anomaly detector for refine-filters prompt focus. NOT a
// classifier — the LLM does the classification. This surfaces candidates:
//
//   - shared_substring: a substring >= 40 chars that appears verbatim in
//     3+ items from the same source. Strong signal of boilerplate.
//   - short_field: field length < threshold. Signals truncated/empty data.
//   - duplicate_value: same value repeats 3+ times across items in a
//     source. For title, signals template leak (the site's section name
//     scraped as job title). For location, signals every job is one place.
//   - pipe_dump: field contains 3+ pipe-separated segments. Signals nav/
//     UI text joined instead of real content.
//   - looks_qualification: (location only) matches a qualification pattern
//     (Bachelor, Master, B.Sc, etc.) instead of a place name.
//
// Output shape:
//   { <source>: { <field>: [{ type, count, samples: [...], detail }] } }
//
// The phase flattens this into the LLM prompt as a per-source digest so the
// LLM can focus on the fields that actually need rule proposals instead of
// guessing from thousands of clean items.

const QUAL_RE = /\b(Bachelor|Master|B\.?Sc|B\.?A|B\.?B\.?A|M\.?Sc|M\.?B\.?A|BIM|BBS|BBA|degree|Computer Science|Information Technology|Business Administration|\d+\s*years?(\s+of)?\s+experience)\b/i;

const FIELD_MIN = { title: 4, description: 40, location: 3 };

function fieldLength(field) {
    return { title: 4, description: 80, location: 3 }[field] || 3;
}

function shortThreshold(field) {
    // description is the only field where "short" is genuinely useful signal.
    // short title (< 4 chars) is rare; short location is usually meaningful
    // ("Remote"). Only flag descriptions under 80 chars.
    return field === 'description' ? 80 : null;
}

/**
 * Find substrings of length >= minLen that appear verbatim in 3+ items.
 * Cheap rolling approach: slice each item's field at every offset, hash the
 * next minLen chars, count duplicates. Not exhaustive but finds boilerplate.
 *
 * Real trick: after the substring is found, extend it maximally to the left
 * and right within items where it appears to get the FULL paragraph.
 */
function sharedSubstrings(items, field, minLen = 40, minCount = 3) {
    const counts = new Map();
    for (const it of items) {
        const v = String(it[field] || '');
        if (v.length < minLen) continue;
        for (let i = 0; i + minLen <= v.length; i++) {
            const k = v.slice(i, i + minLen);
            if (!counts.has(k)) counts.set(k, []);
            counts.get(k).push(it);
        }
    }
    // Collect substrings that appear in >= minCount distinct items
    const candidates = [];
    for (const [substr, itList] of counts) {
        const distinctIds = new Set(itList.map(i => i.id || i.title || i.url));
        if (distinctIds.size < minCount) continue;
        candidates.push({ substr, count: distinctIds.size });
    }
    // Deduplicate overlapping candidates: prefer longest.
    candidates.sort((a, b) => b.substr.length - a.substr.length || b.count - a.count);
    const kept = [];
    for (const c of candidates) {
        const alreadyCovered = kept.some(k => k.substr.includes(c.substr));
        if (alreadyCovered) continue;
        kept.push(c);
        if (kept.length >= 5) break;
    }
    // Extend each kept substring to paragraph boundaries within a sample item
    return kept.map(c => {
        const sample = items.find(it => String(it[field] || '').includes(c.substr));
        let extended = c.substr;
        if (sample) {
            const full = String(sample[field] || '');
            let idx = full.indexOf(c.substr);
            // extend left to previous \n or sentence boundary
            let start = idx;
            while (start > 0 && full[start - 1] !== '\n' && start > idx - 200) start--;
            // extend right to next \n or sentence boundary
            let end = idx + c.substr.length;
            while (end < full.length && full[end] !== '\n' && end < idx + c.substr.length + 400) end++;
            extended = full.slice(start, end).trim();
        }
        return { substr: c.substr, extended, count: c.count };
    });
}

function duplicates(items, field, minCount = 3) {
    const counts = new Map();
    for (const it of items) {
        const v = String(it[field] || '').trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, n]) => n >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
}

function pipeDumps(items, field) {
    return items.filter(it => String(it[field] || '').split('|').length >= 3);
}

function qualificationLocations(items) {
    return items.filter(it => {
        const loc = String(it.location || '');
        if (!loc || loc.length > 120) return false;
        return QUAL_RE.test(loc);
    });
}

/**
 * Detect anomalies across a set of items grouped by source.
 * @param {Array<Object>} items  full items (post-sanitize)
 * @param {string} itemType  'job' | 'event' | 'scholarship'
 * @returns {Object}  { <source>: { <field>: [...] } }
 */
function detectAnomalies(items, itemType) {
    const bySource = {};
    for (const it of items) {
        const src = it.source || 'unknown';
        if (!bySource[src]) bySource[src] = { items: [], itemType };
        bySource[src].items.push(it);
    }

    const out = {};
    for (const [src, group] of Object.entries(bySource)) {
        const srcOut = {};
        const fields = ['title', 'description'];
        if (itemType === 'job' || itemType === 'scholarship') fields.push('location', 'salary');
        if (itemType === 'event') fields.push('location', 'date', 'price');

        for (const field of fields) {
            const fieldAnomalies = [];

            // Shared substrings in description (boilerplate candidates)
            if (field === 'description') {
                const subs = sharedSubstrings(group.items, 'description', 40, 3);
                for (const s of subs) {
                    fieldAnomalies.push({
                        type: 'shared_substring',
                        count: s.count,
                        samples: [s.extended.slice(0, 300)]
                    });
                }
            }

            // Short descriptions
            if (field === 'description') {
                const short = group.items.filter(it => {
                    const d = String(it.description || '');
                    return d.length > 0 && d.length < 80;
                });
                if (short.length >= 2) {
                    fieldAnomalies.push({
                        type: 'short_field',
                        count: short.length,
                        samples: short.slice(0, 3).map(it => it.description)
                    });
                }
            }

            // Duplicate values (title repetition → template leak; location dup → all jobs same place)
            if (field === 'title' || field === 'location') {
                const dups = duplicates(group.items, field, 3);
                for (const d of dups) {
                    fieldAnomalies.push({
                        type: field === 'title' ? 'duplicate_title' : 'duplicate_location',
                        count: d.count,
                        samples: [d.value]
                    });
                }
            }

            // Pipe dumps
            if (field === 'description') {
                const pds = pipeDumps(group.items, field);
                if (pds.length >= 2) {
                    fieldAnomalies.push({
                        type: 'pipe_dump',
                        count: pds.length,
                        samples: pds.slice(0, 2).map(it => String(it.description).slice(0, 250))
                    });
                }
            }

            // Qualification-like locations
            if (field === 'location') {
                const qls = qualificationLocations(group.items);
                if (qls.length >= 1) {
                    fieldAnomalies.push({
                        type: 'looks_qualification',
                        count: qls.length,
                        samples: qls.slice(0, 3).map(it => it.location)
                    });
                }
            }

            if (fieldAnomalies.length > 0) srcOut[field] = fieldAnomalies;
        }

        if (Object.keys(srcOut).length > 0) out[src] = { itemCount: group.items.length, anomalies: srcOut };
    }
    return out;
}

module.exports = { detectAnomalies, sharedSubstrings, duplicates };
