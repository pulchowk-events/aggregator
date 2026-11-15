// scripts/wizard/fieldEvidence.js
//
// Field-oriented DOM evidence extractor. Runs against a live page and
// reports every DOM element that MIGHT hold each field of interest.
//
// Sources of evidence (in order of reliability):
//   1. JSON-LD JobPosting schemas -- the single highest-value source.
//      A site that publishes JobPosting structured data has everything
//      the extractor needs in one parse.
//   2. OpenGraph meta tags (og:site_name -> company, og:title -> title,
//      og:description -> description fallback).
//   3. Scoped selector hints (title/company/location/salary/...).
//      Scope is passed explicitly so single-page-card sites can restrict
//      the scan to ONE card element instead of matching every nav/footer
//      element on the page.
//
// Consumed by prompt.js (the "## Per-field evidence" section) and by
// refine.js (the "you claimed X was absent, but DOM contains Y" gate).

// Selector hints per field. IMPORTANT: only semantic prefixes.
// [class*="city"] matches "opacity" (Tailwind opacity-70). [class*="place"]
// matches "placeholder". [class*="pay"] matches "display". Each of those
// produces false-positive evidence that makes the LLM think a field is
// present when it isn't -- or vice versa, matching site chrome instead of
// per-item data. Use `[class*="job-X"]`, `[class*="role-X"]`,
// `[class*="company"]`, etc. Only unprefixed semantic tokens (location,
// address, salary, deadline) where the word is unambiguously a field name.
const FIELD_SELECTOR_HINTS = {
    title: [
        'h1[class*="job-title"]', 'h1[class*="role-title"]', 'h1[class*="position-title"]',
        'h1[class*="job-name"]', 'h1[class*="role-name"]', 'h1[class*="position-name"]',
        '[class*="job-title"]', '[class*="role-title"]', '[class*="position-title"]',
        '[itemprop="title"]',
        // Generic h1 last -- only when scoped to a card/detail root.
        'h1', 'h2'
    ],
    company: [
        '[class*="company-name"]', '[class*="company-title"]',
        '[class*="employer-name"]', '[class*="employer"]',
        '[class*="hiring-org"]', '[class*="hiring-organization"]',
        '[itemprop="hiringOrganization"]',
        // Header / footer logo links -- company is often only in site chrome
        'header [class*="logo"] a', 'header a[href="/"]', 'footer [class*="logo"] a'
    ],
    location: [
        '[class*="job-location"]', '[class*="role-location"]',
        '[class*="company-location"]', '[class*="office-location"]',
        '[class*="workplace-location"]', '[class*="job-address"]',
        '[itemprop="address"]', '[itemprop="jobLocation"]',
        '[class*="location"]', '[class*="address"]'
    ],
    salary: [
        '[class*="job-salary"]', '[class*="role-salary"]',
        '[class*="salary"]', '[class*="compensation"]', '[class*="remuneration"]',
        '[itemprop="baseSalary"]'
    ],
    employmentType: [
        '[class*="job-type"]', '[class*="jobtype"]',
        '[class*="employment-type"]', '[class*="work-type"]',
        '[itemprop="employmentType"]'
    ],
    applicationEndsRaw: [
        '[class*="job-deadline"]', '[class*="application-deadline"]',
        '[class*="apply-by"]', '[class*="applyby"]',
        '[class*="end-date"]', '[class*="closing-date"]',
        '[itemprop="validThrough"]',
        'time[datetime]'
    ],
    description: [
        'article[class*="job"]', 'article[class*="role"]',
        '[class*="job-description"]', '[class*="role-description"]',
        '[class*="job-body"]', '[class*="role-body"]',
        '[class*="job-details"]', '[class*="job-content"]',
        '[itemprop="description"]',
        'main article', 'main [class*="content"]'
    ],
    openings: [
        '[class*="job-openings"]', '[class*="vacancy-count"]',
        '[class*="openings"]', '[class*="vacanc"]',
        '[itemprop="totalJobOpenings"]'
    ],
    publishedAt: [
        '[class*="job-posted"]', '[class*="date-posted"]',
        '[class*="published-date"]', '[class*="posted-date"]',
        '[itemprop="datePosted"]',
        'time[datetime]'
    ]
};

/**
 * Extract field evidence from a page.
 *
 * @param {Page} page Puppeteer page
 * @param {Object} opts
 *   - scopeSelector: CSS selector that limits the search to one element.
 *     For single-page-card sites: '.job-card' or the cardCandidate selector.
 *     For detail pages: null (whole document is the item).
 *   - includeJsonLd: parse JSON-LD JobPosting blocks. Default true.
 *   - includeOgMeta: parse og: meta tags. Default true.
 *
 * @returns {Promise<Object>} {
 *   jsonLd: [{ field, value, path }] -- from JobPosting schemas
 *   ogMeta: { site_name, title, description, ... }
 *   fields: { <field>: [{ selector, tag, text }] }
 * }
 */
async function extractFieldEvidence(page, opts = {}) {
    const scopeSelector = opts.scopeSelector || null;
    const includeJsonLd = opts.includeJsonLd !== false;
    const includeOgMeta = opts.includeOgMeta !== false;

    return page.evaluate((cfg) => {
        const out = { jsonLd: [], ogMeta: {}, fields: {} };

        // ---- 1. JSON-LD JobPosting ----
        if (cfg.includeJsonLd) {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const s of scripts) {
                let data;
                try { data = JSON.parse(s.textContent); } catch (e) { continue; }
                const walk = (node) => {
                    if (!node || typeof node !== 'object') return;
                    if (Array.isArray(node)) { node.forEach(walk); return; }
                    const t = node['@type'];
                    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                        const pick = (key) => {
                            const v = node[key];
                            if (v == null) return null;
                            if (typeof v === 'string' || typeof v === 'number') return String(v);
                            if (typeof v === 'object') return JSON.stringify(v).slice(0, 300);
                            return null;
                        };
                        const orgName = node.hiringOrganization && node.hiringOrganization.name;
                        const loc = node.jobLocation && node.jobLocation.address;
                        const locStr = loc
                            ? [loc.addressLocality, loc.addressRegion, loc.addressCountry].filter(Boolean).join(', ')
                            : null;
                        const pairs = {
                            title: pick('title') || pick('name'),
                            company: orgName || null,
                            location: locStr || pick('jobLocation'),
                            description: pick('description'),
                            employmentType: Array.isArray(node.employmentType) ? node.employmentType.join(', ') : pick('employmentType'),
                            applicationEndsRaw: pick('validThrough'),
                            publishedAt: pick('datePosted'),
                            salary: node.baseSalary
                                ? (typeof node.baseSalary === 'object'
                                    ? [node.baseSalary.value && node.baseSalary.value.value, node.baseSalary.currency].filter(Boolean).join(' ')
                                    : pick('baseSalary'))
                                : null
                        };
                        for (const [field, value] of Object.entries(pairs)) {
                            if (value && String(value).trim()) {
                                out.jsonLd.push({ field, value: String(value).slice(0, 300), source: 'JobPosting JSON-LD' });
                            }
                        }
                    }
                    for (const k of Object.keys(node)) {
                        if (k !== '@context' && typeof node[k] === 'object') walk(node[k]);
                    }
                };
                walk(data);
            }
        }

        // ---- 2. OpenGraph meta ----
        if (cfg.includeOgMeta) {
            const og = (prop) => {
                const el = document.querySelector(`meta[property="${prop}"]`) ||
                           document.querySelector(`meta[name="${prop}"]`);
                return el ? (el.getAttribute('content') || '').trim() : null;
            };
            out.ogMeta = {
                site_name: og('og:site_name'),
                title: og('og:title'),
                description: og('og:description'),
                url: og('og:url')
            };
        }

        // ---- 3. Scoped selector hints ----
        let root = document;
        if (cfg.scopeSelector) {
            try {
                root = document.querySelector(cfg.scopeSelector) || document;
            } catch (e) {
                // Invalid scope selector -- fall back to document
            }
        }

        for (const [field, selectors] of Object.entries(cfg.hints)) {
            const matches = [];
            const seen = new Set();
            for (const sel of selectors) {
                let els = [];
                try {
                    els = Array.from(root.querySelectorAll(sel)).slice(0, 5);
                } catch (e) { continue; }
                for (const el of els) {
                    let text = '';
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'meta') text = (el.getAttribute('content') || '').trim();
                    else if (tag === 'time') text = (el.getAttribute('datetime') || el.textContent || '').trim();
                    else if (tag === 'link') text = (el.getAttribute('href') || '').trim();
                    else text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!text || text.length < 2 || text.length > 500) continue;
                    const key = `${sel}|${text.slice(0, 100)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    matches.push({ selector: sel, tag, text: text.slice(0, 200) });
                    if (matches.length >= 8) break;
                }
                if (matches.length >= 8) break;
            }
            if (matches.length > 0) out.fields[field] = matches;
        }

        return out;
    }, {
        hints: FIELD_SELECTOR_HINTS,
        scopeSelector,
        includeJsonLd,
        includeOgMeta
    });
}

/**
 * Format the evidence for prompt embedding. Compact text form the LLM
 * can read without a JSON parser.
 */
function formatEvidenceForPrompt(evidence, sourceName) {
    const lines = [];
    if (evidence.jsonLd.length > 0) {
        lines.push('### Structured data (JSON-LD JobPosting -- authoritative)');
        const byField = {};
        for (const entry of evidence.jsonLd) {
            if (!byField[entry.field]) byField[entry.field] = [];
            byField[entry.field].push(entry.value);
        }
        for (const [field, values] of Object.entries(byField)) {
            lines.push(`- ${field}: ${JSON.stringify(values[0]).slice(0, 250)}${values.length > 1 ? ` (+${values.length - 1} more)` : ''}`);
        }
        lines.push('');
    }
    const og = evidence.ogMeta;
    const ogPairs = Object.entries(og).filter(([, v]) => v);
    if (ogPairs.length > 0) {
        lines.push('### OpenGraph meta');
        for (const [k, v] of ogPairs) lines.push(`- og:${k.replace('_', ':')} = ${JSON.stringify(v).slice(0, 200)}`);
        lines.push('');
    }
    const fields = evidence.fields;
    if (Object.keys(fields).length > 0) {
        lines.push('### DOM elements found by field');
        for (const [field, matches] of Object.entries(fields)) {
            lines.push(`- **${field}**: ${matches.length} match(es)`);
            for (const m of matches.slice(0, 3)) {
                lines.push(`  - \`${m.selector}\` <${m.tag}>: ${JSON.stringify(m.text.slice(0, 120))}`);
            }
        }
        lines.push('');
    }
    if (lines.length === 0) {
        lines.push(`No field evidence found via JSON-LD, og: meta, or selector hints for ${sourceName}.`);
    }
    return lines.join('\n');
}

module.exports = { extractFieldEvidence, formatEvidenceForPrompt, FIELD_SELECTOR_HINTS };
