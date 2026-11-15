// src/scrapers/extractors/jobs/lftechnology.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// Recruitee-hosted ATS at career.lftechnology.com. Listing links are
// /o/<slug>. Detail pages carry a JobPosting JSON-LD block which is
// authoritative for title/company/location/description/employmentType/
// datePosted/validThrough/baseSalary. Fall back to DOM selectors only
// when a JSON-LD field is missing.
//
// Selector evidence (from wizard dump):
//   - listing job links: /o/<slug> (e.g. /o/ai-integration-engineer-1)
//   - detail title: H1.sc-1lss5cy-2
//   - detail description block: div.sc-1fwbcuw-0.iMCTcK
//   - location: [class*="job-location"] li / [class*="location"] li
//   - JobPosting JSON-LD present on detail pages

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const CAREERS_URL = 'https://career.lftechnology.com/';
const SOURCE = 'lftechnology';
const COMPANY_FALLBACK = 'Leapfrog Technology';

function stripHtml(s) {
    if (!s) return s;
    return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeEmploymentType(v) {
    if (!v) return null;
    const s = String(v).toLowerCase();
    if (s.includes('full')) return 'full-time';
    if (s.includes('part')) return 'part-time';
    if (s.includes('contract')) return 'contract';
    if (s.includes('intern')) return 'internship';
    return v;
}

function classifyFromText(txt) {
    const out = { employmentType: null, location: null, salary: null };
    if (!txt) return out;
    const lower = txt.toLowerCase();
    if (/\bfull[\s-]?time\b/.test(lower)) out.employmentType = 'full-time';
    else if (/\bpart[\s-]?time\b/.test(lower)) out.employmentType = 'part-time';
    else if (/\bintern(ship)?\b/.test(lower)) out.employmentType = 'internship';
    else if (/\bcontract(?:or)?\b/.test(lower)) out.employmentType = 'contract';

    const sm = txt.match(/(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum))?/i);
    if (sm) out.salary = sm[0].trim();

    if (/kathmandu/i.test(txt)) out.location = 'Kathmandu, Nepal';
    else if (/\bnepal\b/i.test(txt)) out.location = 'Nepal';
    else if (/\bremote\b/i.test(txt)) out.location = 'Remote';
    else if (/\bhybrid\b/i.test(txt)) out.location = 'Hybrid';
    return out;
}

function normalizeLocationFromJsonLd(jobLocation) {
    if (!jobLocation) return null;
    const arr = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
    for (const loc of arr) {
        if (!loc) continue;
        const addr = loc.address || loc;
        const parts = [];
        if (addr.addressLocality) parts.push(addr.addressLocality);
        if (addr.addressRegion && addr.addressRegion !== addr.addressLocality) parts.push(addr.addressRegion);
        if (addr.addressCountry) parts.push(addr.addressCountry);
        if (parts.length) return parts.join(', ');
    }
    return null;
}

function formatSalary(baseSalary) {
    if (!baseSalary) return null;
    if (typeof baseSalary === 'string') return baseSalary;
    if (Array.isArray(baseSalary)) return formatSalary(baseSalary[0]);
    if (typeof baseSalary === 'object') {
        const val = baseSalary.value;
        const currency = baseSalary.currency;
        const unit = baseSalary.unitText;
        let valueStr = null;
        if (val && typeof val === 'object') {
            if (val.minValue != null && val.maxValue != null) valueStr = `${val.minValue}-${val.maxValue}`;
            else if (val.value != null) valueStr = String(val.value);
        } else if (val != null) {
            valueStr = String(val);
        }
        if (valueStr) return [currency, valueStr, unit].filter(Boolean).join(' ');
    }
    return null;
}

async function harvestJobLinks(page) {
    return page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            let abs;
            try { abs = new URL(href, window.location.href); } catch (e) { return; }
            if (abs.host !== 'career.lftechnology.com') return;
            if (!/^\/o\/[^/?#]+/.test(abs.pathname)) return;
            if (/talent-pool/i.test(abs.pathname)) return;
            out.add(abs.toString());
        });
        return Array.from(out);
    });
}

async function readDetail(page) {
    return page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        let jobPosting = null;
        for (const s of scripts) {
            try {
                const parsed = JSON.parse(s.textContent);
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                for (const obj of arr) {
                    if (!obj || typeof obj !== 'object') continue;
                    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
                    if (types.includes('JobPosting')) { jobPosting = obj; break; }
                    if (Array.isArray(obj['@graph'])) {
                        for (const g of obj['@graph']) {
                            if (!g || typeof g !== 'object') continue;
                            const gt = Array.isArray(g['@type']) ? g['@type'] : [g['@type']];
                            if (gt.includes('JobPosting')) { jobPosting = g; break; }
                        }
                    }
                    if (jobPosting) break;
                }
                if (jobPosting) break;
            } catch (e) { /* not JSON */ }
        }

        const og = (name) => {
            const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
            return el ? el.getAttribute('content') : null;
        };

        const titleEl = document.querySelector('h1.sc-1lss5cy-2')
            || document.querySelector('h1[class*="sc-1lss5cy"]')
            || document.querySelector('main h1')
            || document.querySelector('h1');
        const titleFallback = titleEl ? (titleEl.textContent || '').trim() : null;

        const descEl = document.querySelector('div.sc-1fwbcuw-0.iMCTcK')
            || document.querySelector('[class*="job-description"]')
            || document.querySelector('main [class*="content"]')
            || document.querySelector('article');
        const descFallback = descEl ? (descEl.innerText || descEl.textContent || '').trim() : null;

        const locEl = document.querySelector('[class*="job-location"] li')
            || document.querySelector('[class*="location"] li')
            || document.querySelector('[class*="job-location"]')
            || document.querySelector('[class*="location"]');
        const locFallback = locEl ? (locEl.innerText || locEl.textContent || '').trim() : null;

        let image = og('og:image');
        if (!image) {
            const img = document.querySelector('main img, article img, img');
            if (img) {
                try {
                    image = window.__resolveImageSrc ? window.__resolveImageSrc(img) : (img.currentSrc || img.src);
                } catch (e) {
                    image = img.src || null;
                }
            }
        }

        return {
            jobPosting,
            titleFallback,
            descFallback,
            locFallback,
            image,
            finalUrl: window.location.href,
            ogTitle: og('og:title'),
            ogSiteName: og('og:site_name')
        };
    });
}

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];
        const seenTitles = new Set();

        // ---- 1. Load listing ---------------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL);
            await delay(900 + Math.random() * 700);
        } catch (e) {
            console.warn(`[lftechnology] listing load failed: ${e.message}`);
            return { items, meta };
        }

        // ---- 2. Block detection ------------------------------------------
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[lftechnology] blocked: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // ---- 3. Harvest detail links -------------------------------------
        let links = [];
        try { links = await harvestJobLinks(page); } catch (e) { /* best-effort */ }
        links = Array.from(new Set(links));
        meta.listingHits = links.length;
        safeDiscovered(progress, links.length);

        if (links.length === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no job links)`);
            return { items, meta };
        }

        // ---- 4. Per-detail extraction ------------------------------------
        for (const link of links) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, link);
                await delay(700 + Math.random() * 600);

                let data = null;
                try { data = await readDetail(page); } catch (e) { /* best-effort */ }
                if (!data) {
                    meta.detailParseFailures++;
                    continue;
                }

                const jp = data.jobPosting || {};
                const title = (jp.title && String(jp.title).trim()) || data.titleFallback;
                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }
                const titleKey = title.toLowerCase();
                if (seenTitles.has(titleKey)) {
                    continue;
                }
                seenTitles.add(titleKey);

                const company = (jp.hiringOrganization && (jp.hiringOrganization.name || jp.hiringOrganization))
                    || data.ogSiteName
                    || COMPANY_FALLBACK;

                const locationFromJp = normalizeLocationFromJsonLd(jp.jobLocation);
                const location = locationFromJp || data.locFallback || null;

                const rawDesc = jp.description
                    ? stripHtml(jp.description)
                    : (data.descFallback || null);
                let description = rawDesc;
                if (description) {
                    try {
                        description = trimDescriptionToLastSentence(
                            cleanDescriptionText(description), 6000
                        );
                    } catch (e) { /* keep raw */ }
                }

                const cls = classifyFromText([description, location, jp.employmentType].filter(Boolean).join(' '));

                const employmentType = normalizeEmploymentType(jp.employmentType) || cls.employmentType || null;
                const salary = formatSalary(jp.baseSalary) || cls.salary || null;
                const applicationEndsRaw = jp.validThrough || null;
                const publishedAt = jp.datePosted || null;

                const isRemote = (jp.jobLocationType && String(jp.jobLocationType).toUpperCase().includes('TELECOMMUTE'))
                    || (location && /remote/i.test(location));
                const attendanceMode = isRemote ? 'online' : 'in-person';

                const item = {
                    id: `${SOURCE}-${slugify(title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    title,
                    company,
                    company_status: 'extracted',
                    company_evidence: jp.hiringOrganization
                        ? 'JobPosting JSON-LD hiringOrganization.name'
                        : (data.ogSiteName ? 'og:site_name' : 'fallback company constant'),

                    description: description || null,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description
                        ? (jp.description ? 'JobPosting JSON-LD description' : 'detail DOM description block')
                        : 'no JobPosting.description and no prose block on detail page',

                    location: location || null,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: location
                        ? (locationFromJp ? 'JobPosting JSON-LD jobLocation.address' : 'detail DOM [class*="job-location"]')
                        : 'no jobLocation in JSON-LD and no location element in DOM',

                    employmentType: employmentType || null,
                    employmentType_status: employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: employmentType
                        ? (jp.employmentType ? 'JobPosting JSON-LD employmentType' : 'matched employment-type regex in body')
                        : 'no employmentType in JSON-LD and no match in body',

                    applicationEndsRaw: applicationEndsRaw || null,
                    applicationEnds_status: applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: applicationEndsRaw
                        ? 'JobPosting JSON-LD validThrough'
                        : 'no validThrough in JSON-LD',

                    salary: salary || null,
                    salary_status: salary ? 'extracted' : 'site_absent',
                    salary_evidence: salary
                        ? (jp.baseSalary ? 'JobPosting JSON-LD baseSalary' : 'matched salary regex in body')
                        : 'no baseSalary in JSON-LD and no salary string in body',

                    image: data.image || null,
                    image_status: data.image ? 'extracted' : 'site_absent',
                    image_evidence: data.image ? 'og:image or first content img' : 'no og:image or content img',

                    date: null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: 'Engineering',
                    tags: ['engineering', 'leapfrog'],
                    url: data.finalUrl || link,
                    registrationUrl: data.finalUrl || link,
                    attendanceMode,
                    publishedAt: publishedAt || null,
                    source: SOURCE
                };

                items.push(item);
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        if (items.length === 0) {
            meta.atsEmpty = true;
        }

        console.log(`  [${SOURCE}] extracted ${items.length}`);
        return { items, meta };
    }
};

function slugify(s) {
    return String(s || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}