// src/scrapers/extractors/jobs/lunover.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CORRECTION of wizard assumptions -- the raw dump was misleading:
//   - "listing-to-detail" is UNVERIFIED. The 6 `/` anchors are the
//     logo and in-page `#` anchors (careers-at-lunover, why-work-with-us).
//     The 8+ "detailLinkCandidates" are all `/services/...` service
//     pages, NOT job postings.
//   - Card wrapper `meta` (25) is <meta> tags, not job cards.
//   - No cardCandidates under "Current Openings" were captured, so we
//     have no static selector for the role cards.
//
// What we DO know from the dump:
//   - careers page <h2> section "Current Openings" exists (evidence:
//     fieldEvidence.title lists h2 "Current Openings").
//   - og:site_name = "Lunover"; og:description mentions "open roles".
//   - The site is a Next.js (App Router) build and a Nepali agency,
//     so roles may be rendered server-side in the "Current Openings"
//     section, loaded client-side, or proxied through an ATS widget.
//
// Strategy (defensive -- no invented selectors):
//   1. Attach a response listener BEFORE navigation to capture any
//      JSON payload that looks like a job list (ATS widgets on Next.js
//      careers pages frequently ship one).
//   2. Load careers page, detect block state, scroll past the
//      "Current Openings" section so lazy content renders.
//   3. If a captured job JSON payload exists, prefer it.
//   4. Otherwise scan the "Current Openings" section for same-domain
//      anchors and inline cards. Accept any same-domain href whose
//      path is NOT a services / marketing route and whose text/path
//      matches a role keyword (engineer/developer/designer/manager/
//      analyst/intern/etc).
//   5. If a per-role detail URL is found, follow it and extract there;
//      if only inline cards, emit straight from the card.
//   6. If nothing resolves, return cleanly with meta.atsEmpty = true.
//
// Field handling:
//   - company: og:site_name "Lunover" (Tier 1 extracted).
//   - location: no per-role element in evidence; classify from card
//     body, else default "Nepal" (site is a Nepali agency).
//   - description: card sibling prose when present, else detail
//     content block; else site_absent.
//   - salary / applicationEndsRaw / image: site_absent unless a job
//     JSON payload carries them.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const CAREERS_URL = 'https://www.lunover.com/careers/';
const SOURCE = 'lunover';
const DEFAULT_COMPANY = 'Lunover';
const DEFAULT_LOCATION = 'Nepal';

// Non-job path fragments that must never be followed.
const NON_JOB_PATH = /\/(services|about|case-stud|case-studies|blog|contact|book|pricing|privacy|terms|cookies?|np|careers?\/?$)\b/i;

// Role-title keyword matcher (English + a couple of common variants).
const ROLE_WORD = /(engineer|developer|designer|manager|analyst|intern(ship)?|lead|architect|\bqa\b|devops|\bsre\b|specialist|consultant|director|officer|associate|executive|programmer|administrator|tester|scientist|writer|marketer|recruiter|accountant|sales|support)/i;

// ATS hosts -- accept any of these.
const ATS_HOST = /(greenhouse\.io|lever\.co|workable|bamboohr|recruitee|smartrecruiters|teamtailor|join\.com|personio|ashbyhq)/i;

function classifyBody(txt) {
    const out = { employmentType: null, location: null, salary: null };
    if (!txt) return out;
    const lower = txt.toLowerCase();

    if (/\bfull[\s-]?time\b/.test(lower)) out.employmentType = 'full-time';
    else if (/\bpart[\s-]?time\b/.test(lower)) out.employmentType = 'part-time';
    else if (/\bintern(ship)?\b/.test(lower)) out.employmentType = 'internship';
    else if (/\bcontract(?:or)?\b/.test(lower)) out.employmentType = 'contract';

    const sm = txt.match(/(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum|lpa))?/i);
    if (sm) out.salary = sm[0].trim();

    if (/kathmandu/i.test(txt)) out.location = 'Kathmandu, Nepal';
    else if (/\bnepal\b/i.test(txt)) out.location = 'Nepal';
    else if (/\bremote\b/i.test(txt)) out.location = 'Remote';
    else if (/\bhybrid\b/i.test(txt)) out.location = 'Hybrid';
    return out;
}

// Heuristic: does this JSON payload look like a list of job openings?
function looksLikeJobArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const sample = arr.slice(0, 5);
    let titleHits = 0;
    let extraHits = 0;
    for (const row of sample) {
        if (!row || typeof row !== 'object') continue;
        const keys = Object.keys(row).map((k) => k.toLowerCase());
        if (keys.some((k) => /^(title|name|jobtitle|job_title|position|role)$/.test(k))) titleHits++;
        if (keys.some((k) => /^(location|office|city|department|employmenttype|employment_type|url|applyurl|apply_url)$/.test(k))) extraHits++;
    }
    return titleHits >= Math.min(2, sample.length) && extraHits >= 1;
}

async function scrollThroughCurrentOpenings(page) {
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // Try to land on the "Current Openings" anchor.
        let anchor = null;
        document.querySelectorAll('h2, h3').forEach((h) => {
            if (anchor) return;
            if (/current openings|open roles|open positions|openings|vacanc/i.test(h.textContent || '')) {
                anchor = h;
            }
        });
        if (anchor) {
            try { anchor.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch (e) {}
            await sleep(500);
        }
        // Then walk the page so any IntersectionObserver / hydration fires.
        const step = 600;
        let y = 0;
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        while (y < h) {
            window.scrollTo(0, y);
            y += step;
            await sleep(80);
        }
        window.scrollTo(0, 0);
    });
}

// Reads the "Current Openings" section: same-domain anchors + inline cards.
async function harvestFromOpeningsSection(page) {
    return page.evaluate((ROLE_SRC, NONJOB_SRC, ATS_SRC) => {
        const ROLE = new RegExp(ROLE_SRC, 'i');
        const NONJOB = new RegExp(NONJOB_SRC, 'i');
        const ATS = new RegExp(ATS_SRC, 'i');
        const links = new Set();
        const cards = [];
        const seenTitles = new Set();

        // Locate "Current Openings" section (or fall back to the whole main).
        let section = null;
        document.querySelectorAll('h1, h2, h3').forEach((h) => {
            if (section) return;
            if (/current openings|open roles|open positions|openings|vacanc/i.test(h.textContent || '')) {
                section = h.closest('section') || h.closest('[class*="section"]') || h.parentElement;
            }
        });
        const root = section || document.querySelector('main') || document.body;

        // (a) Anchors that look like a role detail link.
        root.querySelectorAll('a[href]').forEach((a) => {
            const raw = a.getAttribute('href') || '';
            if (!raw) return;
            let abs;
            try { abs = new URL(raw, window.location.href); } catch (e) { return; }

            // Exclude anchors that clearly aren't jobs.
            if (abs.hostname === window.location.hostname) {
                const p = abs.pathname;
                if (p === '/careers' || p === '/careers/') return;
                if (NONJOB.test(p)) return;
                if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(p) && !/job|role|position|opening|career/i.test(p)) return;
            }
            if (/(#|javascript:|mailto:|tel:)/i.test(raw)) return;

            const text = (a.textContent || '').trim();
            const hay = (abs.pathname + ' ' + text).toLowerCase();
            const isAts = ATS.test(abs.hostname);
            if (!isAts && !ROLE.test(hay) && !/job|role|position|opening|career/i.test(abs.pathname)) return;
            if (isAts && abs.pathname === '/') return;
            links.add(abs.toString());
        });

        // (b) Inline cards within the openings section.
        const candidates = root.querySelectorAll(
            'article, li, [class*="card"], [class*="job"], [class*="role"], [class*="position"], [class*="opening"]'
        );
        candidates.forEach((el) => {
            const headEl = el.querySelector('h2, h3, h4, h5');
            if (!headEl) return;
            const title = (headEl.textContent || '').trim().replace(/\s+/g, ' ');
            if (!title || title.length < 3 || title.length > 140) return;
            if (/^(current openings|open roles|open positions|openings|why work with us\??|careers? at lunover|let's build something)/i.test(title)) return;
            if (!ROLE.test(title)) return;
            const k = title.toLowerCase();
            if (seenTitles.has(k)) return;
            seenTitles.add(k);

            let applyUrl = null;
            const linkEl = el.querySelector('a[href]');
            if (linkEl) {
                try { applyUrl = new URL(linkEl.getAttribute('href'), window.location.href).toString(); }
                catch (e) { applyUrl = null; }
            }

            let description = null;
            const text = (el.innerText || '').trim();
            const idx = text.indexOf(title);
            if (idx >= 0 && text.length > idx + title.length + 25) {
                description = text.slice(idx + title.length).trim().slice(0, 4000);
            }

            let location = null;
            const locEl = el.querySelector('[class*="location"], [class*="office"], [class*="city"], [class*="place"]');
            if (locEl) {
                const t = (locEl.textContent || '').trim();
                if (t && t.length < 80) location = t;
            }

            let employmentType = null;
            const typeEl = el.querySelector('[class*="type"], [class*="employment"]');
            if (typeEl) {
                const t = (typeEl.textContent || '').trim();
                if (t && t.length < 40) employmentType = t;
            }

            cards.push({ title, description, location, employmentType, applyUrl });
        });

        return { links: Array.from(links), cards };
    }, ROLE_WORD.source, NON_JOB_PATH.source, ATS_HOST.source);
}

// Extract detail fields from a followed role page.
async function readDetailPage(page) {
    return page.evaluate(() => {
        const main = document.querySelector('main') || document.body;

        const titleEl = main.querySelector('h1') || document.querySelector('h1');
        const title = titleEl ? (titleEl.textContent || '').trim() : null;

        // Try common job-description blocks.
        const descEl = main.querySelector(
            '[class*="job-description"], [class*="description"], [class*="content"], article'
        );
        let description = null;
        if (descEl) {
            const t = (descEl.innerText || descEl.textContent || '').trim();
            if (t.length > 100) description = t;
        }
        if (!description) {
            // Fallback: concatenate paragraphs under main.
            const ps = Array.from(main.querySelectorAll('p'));
            const joined = ps.map((p) => (p.innerText || '').trim()).filter(Boolean).join('\n\n');
            if (joined.length > 150) description = joined;
        }

        const locEl = main.querySelector('[class*="location"], [class*="office"], [class*="city"], [class*="place"]');
        let location = null;
        if (locEl) {
            const t = (locEl.textContent || '').trim();
            if (t && t.length < 80) location = t;
        }

        const typeEl = main.querySelector('[class*="employment"], [class*="type"]');
        let employmentType = null;
        if (typeEl) {
            const t = (typeEl.textContent || '').trim();
            if (t && t.length < 40) employmentType = t;
        }

        let image = null;
        const og = document.querySelector('meta[property="og:image"]');
        if (og && og.getAttribute('content')) image = og.getAttribute('content');
        if (!image) {
            const img = main.querySelector('img');
            if (img) {
                try { image = window.__resolveImageSrc ? window.__resolveImageSrc(img) : (img.currentSrc || img.src); }
                catch (e) { image = img.src || null; }
            }
        }

        return {
            title,
            description,
            location,
            employmentType,
            image,
            bodyText: (main.innerText || '').slice(0, 10000),
            finalUrl: window.location.href
        };
    });
}

function pickJsonField(row, regex) {
    const lower = {};
    for (const k of Object.keys(row || {})) lower[k.toLowerCase()] = row[k];
    for (const k of Object.keys(lower)) {
        if (regex.test(k)) {
            const v = lower[k];
            if (v != null && v !== '') return v;
        }
    }
    return null;
}

function asString(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') return v.name || v.title || v.value || null;
    return null;
}

function slugify(s) {
    return String(s || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}

// ---------------------------------------------------------------------------
module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 0. Response listener (before navigation) --------------------
        const capturedPayloads = [];
        const onResponse = async (res) => {
            try {
                const ct = (res.headers()['content-type'] || '').toLowerCase();
                if (!/json/.test(ct)) return;
                const u = res.url();
                if (/google|gtag|gtm|facebook|hotjar|segment|doubleclick|hubspot|hs-analytics|hs-scripts|sentry|vercel-insights|clarity/i.test(u)) return;
                const data = await res.json();
                if (!data) return;
                const candidates = [];
                if (Array.isArray(data)) candidates.push(data);
                else if (data && typeof data === 'object') {
                    for (const k of ['jobs', 'positions', 'openings', 'roles', 'data', 'items', 'results', 'vacancies', 'hits']) {
                        if (Array.isArray(data[k])) candidates.push(data[k]);
                    }
                }
                for (const arr of candidates) {
                    if (looksLikeJobArray(arr)) {
                        capturedPayloads.push({ url: u, arr });
                        return;
                    }
                }
            } catch (e) { /* not JSON or unparseable */ }
        };
        try { page.on('response', onResponse); } catch (e) { /* best-effort */ }

        try {
            // ---- 1. Load careers page -----------------------------------
            try {
                meta.pagesVisited++;
                await loadPage(page, CAREERS_URL);
                await delay(1200 + Math.random() * 800);
            } catch (e) {
                console.warn(`[${SOURCE}] careers page load failed: ${e.message}`);
                return { items, meta };
            }

            // ---- 2. Block detection -------------------------------------
            try {
                const state = await detectPageState(page);
                if (state.looksBlocked) {
                    meta.looksBlocked = true;
                    console.warn(`[${SOURCE}] blocked: ${JSON.stringify(state.bodySnippet)}`);
                    return { items, meta };
                }
            } catch (e) { /* best-effort */ }

            // ---- 3. Scroll to trigger lazy render -----------------------
            try { await scrollThroughCurrentOpenings(page); } catch (e) { /* best-effort */ }
            await delay(700 + Math.random() * 500);

            // ---- 4. Page context ----------------------------------------
            let pageCtx = { bodyText: '', logo: null };
            try {
                pageCtx = await page.evaluate(() => {
                    const main = document.querySelector('main') || document.body;
                    const bodyText = (main.innerText || '').slice(0, 16000);
                    let logo = null;
                    const hdrImg = document.querySelector('header img, [class*="header"] img, nav img');
                    if (hdrImg) {
                        try { logo = window.__resolveImageSrc ? window.__resolveImageSrc(hdrImg) : (hdrImg.currentSrc || hdrImg.src); }
                        catch (e) { logo = hdrImg.src || null; }
                    }
                    if (!logo) {
                        const og = document.querySelector('meta[property="og:image"]');
                        if (og && og.getAttribute('content')) logo = og.getAttribute('content');
                    }
                    return { bodyText, logo };
                });
            } catch (e) { /* best-effort */ }

            const clsPage = classifyBody(pageCtx.bodyText || '');

            // ---- 5. Preferred: JSON payload with roles ------------------
            if (capturedPayloads.length > 0) {
                capturedPayloads.sort((a, b) => b.arr.length - a.arr.length);
                const rows = capturedPayloads[0].arr;
                meta.listingHits = rows.length;
                safeDiscovered(progress, rows.length);

                for (const row of rows) {
                    try {
                        const title = asString(pickJsonField(row, /^(title|name|jobtitle|job_title|position|role)$/));
                        if (!title) continue;

                        const rawDesc = asString(pickJsonField(row, /^(description|body|content|jobdescription|job_description|summary)$/));
                        let description = rawDesc;
                        if (description) {
                            try {
                                description = trimDescriptionToLastSentence(cleanDescriptionText(description), 6000);
                            } catch (e) { /* keep raw */ }
                        }

                        const jsonLocation = asString(pickJsonField(row, /^(location|office|city|workplace|place|standort)$/));
                        const jsonType = asString(pickJsonField(row, /^(employmenttype|employment_type|type|contracttype|contract_type)$/));
                        const jsonSalary = asString(pickJsonField(row, /^(salary|compensation|pay|gehalt)$/));
                        const jsonEnd = asString(pickJsonField(row, /^(applicationends|application_ends|deadline|applyby|apply_by|closingdate|closing_date|enddate|end_date)$/));
                        const jsonUrl = asString(pickJsonField(row, /^(url|applyurl|apply_url|joburl|job_url|link|permalink|detailurl|detail_url)$/));
                        const jsonImage = asString(pickJsonField(row, /^(image|imageurl|image_url|logo)$/));
                        const jsonCompany = asString(pickJsonField(row, /^(company|companyname|company_name|employer|organization)$/));
                        const jsonDept = asString(pickJsonField(row, /^(department|category|team|division)$/));

                        const cls = classifyBody(
                            [description, jsonLocation, jsonType, jsonSalary].filter(Boolean).join(' ')
                        );

                        const location = jsonLocation || cls.location || clsPage.location || DEFAULT_LOCATION;
                        const employmentType = jsonType || cls.employmentType || clsPage.employmentType;
                        const salary = jsonSalary || cls.salary || clsPage.salary;

                        let itemUrl = CAREERS_URL;
                        if (jsonUrl) {
                            try { itemUrl = new URL(jsonUrl, CAREERS_URL).toString(); } catch (e) { /* keep default */ }
                        }

                        items.push({
                            id: `${SOURCE}-${slugify(title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            title,
                            company: jsonCompany || DEFAULT_COMPANY,
                            company_status: 'extracted',
                            company_evidence: jsonCompany
                                ? 'company field from jobs JSON payload'
                                : 'og:site_name = "Lunover"',
                            description: description || null,
                            description_status: description ? 'extracted' : 'site_absent',
                            description_evidence: description
                                ? 'description field from jobs JSON payload'
                                : 'jobs payload had no description/body/content field',
                            location,
                            location_status: (jsonLocation || cls.location || clsPage.location) ? 'extracted' : 'site_absent',
                            location_evidence: jsonLocation
                                ? 'location field from jobs JSON payload'
                                : (cls.location || clsPage.location
                                    ? 'matched city/country in text'
                                    : 'default: Lunover is Nepal-based; no location in payload'),
                            employmentType: employmentType || null,
                            employmentType_status: employmentType ? 'extracted' : 'site_absent',
                            employmentType_evidence: employmentType
                                ? 'employment-type field or regex in payload'
                                : 'no employment-type in jobs payload or page body',
                            salary: salary || null,
                            salary_status: salary ? 'extracted' : 'site_absent',
                            salary_evidence: salary
                                ? 'salary field or currency regex in payload'
                                : 'no salary string in jobs payload',
                            applicationEndsRaw: jsonEnd || null,
                            applicationEnds_status: jsonEnd ? 'extracted' : 'site_absent',
                            applicationEnds_evidence: jsonEnd
                                ? 'application-ends field from jobs JSON payload'
                                : 'no deadline/closing field in jobs payload',
                            image: jsonImage || pageCtx.logo || null,
                            image_status: (jsonImage || pageCtx.logo) ? 'extracted' : 'site_absent',
                            image_evidence: jsonImage
                                ? 'image field from jobs JSON payload'
                                : (pageCtx.logo ? 'page og:image / header logo' : 'no per-item image and no page logo'),
                            date: null,
                            time: null,
                            price: null,
                            organizer: jsonCompany || DEFAULT_COMPANY,
                            category: jsonDept || 'Engineering',
                            tags: [jsonDept, 'lunover'].filter(Boolean),
                            url: itemUrl,
                            registrationUrl: itemUrl,
                            attendanceMode: location === 'Remote' ? 'online' : 'in-person',
                            source: SOURCE
                        });
                    } catch (e) {
                        /* skip malformed row */
                    } finally {
                        safeUnitDone(progress);
                    }
                }

                if (items.length > 0) {
                    console.log(`  [${SOURCE}] extracted ${items.length}`);
                    return { items, meta };
                }
            }

            // ---- 6. DOM: harvest from Current Openings section ----------
            let harvested = { links: [], cards: [] };
            try { harvested = await harvestFromOpeningsSection(page); } catch (e) { /* best-effort */ }

            const links = Array.from(new Set(harvested.links || []));
            const cards = harvested.cards || [];
            const totalDiscoverable = links.length || cards.length;
            meta.listingHits = totalDiscoverable;
            safeDiscovered(progress, totalDiscoverable);

            if (totalDiscoverable === 0) {
                meta.atsEmpty = true;
                console.log(`  [${SOURCE}] extracted 0 (no openings resolved)`);
                return { items, meta };
            }

            // ---- 6a. Follow per-role links -----------------------------
            if (links.length > 0) {
                for (const link of links) {
                    try {
                        meta.pagesVisited++;
                        meta.detailPagesVisited++;
                        await loadPage(page, link);
                        await delay(700 + Math.random() * 600);

                        const d = await readDetailPage(page);
                        if (!d || !d.title) {
                            meta.detailParseFailures++;
                            continue;
                        }

                        let description = d.description;
                        if (description) {
                            try {
                                description = trimDescriptionToLastSentence(cleanDescriptionText(description), 6000);
                            } catch (e) { /* keep raw */ }
                        }

                        const cls = classifyBody([d.bodyText, d.location, d.employmentType].filter(Boolean).join(' '));
                        const location = d.location || cls.location || clsPage.location || DEFAULT_LOCATION;
                        const employmentType = d.employmentType || cls.employmentType || clsPage.employmentType;
                        const salary = cls.salary || clsPage.salary;

                        items.push({
                            id: `${SOURCE}-${slugify(d.title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            title: d.title,
                            company: DEFAULT_COMPANY,
                            company_status: 'extracted',
                            company_evidence: 'og:site_name = "Lunover"',
                            description: description || null,
                            description_status: description ? 'extracted' : 'site_absent',
                            description_evidence: description
                                ? 'prose block on detail page ([class*="description"] / article / <p> under main)'
                                : 'no prose block > 100 chars on detail page',
                            location,
                            location_status: (d.location || cls.location || clsPage.location) ? 'extracted' : 'site_absent',
                            location_evidence: d.location
                                ? '[class*="location"] on detail page'
                                : (cls.location || clsPage.location
                                    ? 'matched city/country in detail body'
                                    : 'default: Lunover is Nepal-based; no location on detail page'),
                            employmentType: employmentType || null,
                            employmentType_status: employmentType ? 'extracted' : 'site_absent',
                            employmentType_evidence: employmentType
                                ? 'employment-type element or regex in detail body'
                                : 'no employment-type element or full/part/contract/intern regex on detail page',
                            salary: salary || null,
                            salary_status: salary ? 'extracted' : 'site_absent',
                            salary_evidence: salary
                                ? 'currency regex in detail body'
                                : 'no salary string on detail page',
                            applicationEndsRaw: null,
                            applicationEnds_status: 'site_absent',
                            applicationEnds_evidence: 'no apply-by/closing element on detail page',
                            image: d.image || pageCtx.logo || null,
                            image_status: (d.image || pageCtx.logo) ? 'extracted' : 'site_absent',
                            image_evidence: d.image
                                ? 'og:image or first content img on detail page'
                                : (pageCtx.logo ? 'page logo' : 'no image'),
                            date: null,
                            time: null,
                            price: null,
                            organizer: DEFAULT_COMPANY,
                            category: 'Engineering',
                            tags: ['engineering', 'lunover'],
                            url: d.finalUrl || link,
                            registrationUrl: d.finalUrl || link,
                            attendanceMode: location === 'Remote' ? 'online' : 'in-person',
                            source: SOURCE
                        });
                    } catch (e) {
                        meta.detailParseFailures++;
                    } finally {
                        safeUnitDone(progress);
                    }
                }
            }

            // ---- 6b. Inline cards (if no detail links) -----------------
            if (links.length === 0 && cards.length > 0) {
                for (const c of cards) {
                    try {
                        let description = c.description;
                        if (description) {
                            try {
                                description = trimDescriptionToLastSentence(cleanDescriptionText(description), 4000);
                            } catch (e) { /* keep raw */ }
                        }

                        const cls = classifyBody([c.description, c.location, c.employmentType].filter(Boolean).join(' '));
                        const location = c.location || cls.location || clsPage.location || DEFAULT_LOCATION;
                        const employmentType = c.employmentType || cls.employmentType || clsPage.employmentType;
                        const salary = cls.salary || clsPage.salary;
                        const itemUrl = c.applyUrl || CAREERS_URL;

                        items.push({
                            id: `${SOURCE}-${slugify(c.title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            title: c.title,
                            company: DEFAULT_COMPANY,
                            company_status: 'extracted',
                            company_evidence: 'og:site_name = "Lunover"',
                            description: description || null,
                            description_status: description ? 'extracted' : 'site_absent',
                            description_evidence: description
                                ? 'sibling prose inside Current Openings card'
                                : 'card had no per-role prose',
                            location,
                            location_status: (c.location || cls.location || clsPage.location) ? 'extracted' : 'site_absent',
                            location_evidence: c.location
                                ? 'location element inside card'
                                : (cls.location || clsPage.location
                                    ? 'matched city/country in card body'
                                    : 'default: Lunover is Nepal-based; no per-role location'),
                            employmentType: employmentType || null,
                            employmentType_status: employmentType ? 'extracted' : 'site_absent',
                            employmentType_evidence: employmentType
                                ? 'employment-type element or regex in card'
                                : 'no employment-type in card',
                            salary: salary || null,
                            salary_status: salary ? 'extracted' : 'site_absent',
                            salary_evidence: salary
                                ? 'currency regex in card body'
                                : 'no salary string in card',
                            applicationEndsRaw: null,
                            applicationEnds_status: 'site_absent',
                            applicationEnds_evidence: 'no apply-by/closing element in card',
                            image: pageCtx.logo || null,
                            image_status: pageCtx.logo ? 'extracted' : 'site_absent',
                            image_evidence: pageCtx.logo ? 'page logo / og:image' : 'no image',
                            date: null,
                            time: null,
                            price: null,
                            organizer: DEFAULT_COMPANY,
                            category: 'Engineering',
                            tags: ['engineering', 'lunover'],
                            url: itemUrl,
                            registrationUrl: itemUrl,
                            attendanceMode: location === 'Remote' ? 'online' : 'in-person',
                            source: SOURCE
                        });
                    } catch (e) {
                        /* skip malformed card */
                    } finally {
                        safeUnitDone(progress);
                    }
                }
            }

            if (items.length === 0) {
                meta.atsEmpty = true;
            }

            console.log(`  [${SOURCE}] extracted ${items.length}`);
            return { items, meta };
        } finally {
            try { page.off('response', onResponse); } catch (e) { /* best-effort */ }
        }
    }
};