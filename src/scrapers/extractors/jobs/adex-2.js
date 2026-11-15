// src/scrapers/extractors/jobs/adex-2.js
// Site-specific extractor. See ../README.md for the contract.
//
// Wizard assumptions corrected:
//   - "card wrapper: div.swiper-slide.swiper-slide-duplicate" was a FALSE POSITIVE.
//     Those 21 nodes are Swiper carousel image slides (background-image only,
//     rotateY transforms, no headings/text). They are NOT job cards.
//   - Real listing is the "Current Openings" section ([class*="openings"]) with
//     filter chips (All / Technology / Business Development / Operations /
//     Account Management / R&D). Cards there are the actual job entries.
//   - No JSON-LD JobPosting, no OpenGraph job data, no detail-link candidates
//     exposed by the wizard. Extract from the openings section and fall back
//     to same-origin job-ish anchors.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CAREER_URL = 'https://adex.ltd/career';

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        console.log('?? [adex-2] Scraping Adex careers...');
        meta.pagesVisited++;

        await loadPage(page, CAREER_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            meta.looksBlocked = true;
            console.log('  [adex-2] looksBlocked');
            return { items: [], meta };
        }

        // Let JS-rendered "Current Openings" hydrate, then park on it.
        await delay(4000);
        await page.evaluate(() => {
            const el = document.querySelector('[class*="openings"]');
            if (el) el.scrollIntoView({ block: 'start' });
            else window.scrollTo(0, document.body.scrollHeight * 0.6);
        }).catch(() => {});
        await delay(2500);

        const raw = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            const BASE = window.location.origin;
            const LISTING_URL = window.location.href;

            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);

            const push = (j) => {
                if (!j || !j.title) return;
                const k = j.title.trim().toLowerCase() + '|' + (j.url || '');
                if (seen.has(k)) return;
                seen.add(k);
                out.push(j);
            };

            const isJobHref = (href) => {
                if (!href) return false;
                try {
                    const u = new URL(href, BASE);
                    if (u.hostname !== window.location.hostname) return false;
                    return /\/(career|careers|job|jobs|position|positions|opening|openings)(\/|$)/i.test(u.pathname);
                } catch (_) { return false; }
            };

            const section = document.querySelector('[class*="openings"]');
            const root = section || document;

            // Defensive multi-selector card discovery inside the openings section.
            const candidateSelectors = [
                '.job-card', '.career-card', '.opening',
                '[class*="job-card"]', '[class*="career-card"]', '[class*="opening-card"]',
                '.card', 'article', 'li',
                '.row > .col-md-4', '.row > .col-lg-4', '.row > .col-sm-6',
                '.row > div[class*="col"]'
            ];

            const seenEls = new Set();
            const candidates = [];
            for (const sel of candidateSelectors) {
                let nodes = [];
                try { nodes = Array.from(root.querySelectorAll(sel)); } catch (_) {}
                for (const el of nodes) {
                    if (seenEls.has(el)) continue;
                    seenEls.add(el);
                    const text = el.textContent || '';
                    if (text.length < 20 || text.length > 2000) continue;
                    candidates.push(el);
                }
            }

            // Prefer cards that carry a job-ish anchor.
            const jobCards = candidates.filter((c) => {
                const a = c.querySelector('a[href]');
                return a && isJobHref(a.getAttribute('href'));
            });
            const chosen = jobCards.length > 0 ? jobCards : candidates;

            for (const card of chosen) {
                // Title: first meaningful heading (skip section/filter labels)
                let title = null;
                for (const h of Array.from(card.querySelectorAll('h2, h3, h4, h5, strong, b'))) {
                    const t = clean(h.textContent);
                    if (!t) continue;
                    if (/^(current openings|openings|all job category|discover your path|focus areas.*)$/i.test(t)) continue;
                    if (t.length >= 3 && t.length <= 120) { title = t; break; }
                }
                if (!title) {
                    const a = card.querySelector('a[href]');
                    if (a) title = clean(a.textContent);
                }
                if (!title) continue;

                // URL
                let url = LISTING_URL;
                let registrationUrl = null;
                const linkEl = card.querySelector('a[href]');
                if (linkEl) {
                    try {
                        const abs = new URL(linkEl.getAttribute('href'), BASE).href;
                        url = abs;
                        registrationUrl = abs;
                    } catch (_) {}
                }

                // Description: longest <p>
                let description = null;
                const ps = Array.from(card.querySelectorAll('p'))
                    .map((p) => clean(p.textContent))
                    .filter(Boolean)
                    .sort((a, b) => b.length - a.length);
                if (ps[0]) description = ps[0];

                // Location
                let location = null;
                const locEl = card.querySelector('[class*="location" i], [class*="loc" i], address');
                if (locEl) location = clean(locEl.textContent);
                if (!location) {
                    const text = clean(card.textContent) || '';
                    const m = text.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|Onsite)\b/i);
                    if (m) location = m[0];
                }

                // Department / category
                let category = null;
                const catEl = card.querySelector('[class*="category" i], [class*="department" i], [class*="team" i]');
                if (catEl) category = clean(catEl.textContent);
                if (!category) {
                    const text = clean(card.textContent) || '';
                    const m = text.match(/\b(Technology|Business Development|Operations|Account Management|R&D|Engineering)\b/i);
                    if (m) category = m[0];
                }

                // Employment type
                let employmentType = null;
                const typeEl = card.querySelector('[class*="type" i], [class*="employment" i]');
                if (typeEl) employmentType = clean(typeEl.textContent);
                if (!employmentType) {
                    const text = clean(card.textContent) || '';
                    const m = text.match(/(full[\s-]?time|part[\s-]?time|contract|internship|intern)/i);
                    if (m) employmentType = m[0];
                }

                // Experience
                let experience = null;
                const expEl = card.querySelector('[class*="experience" i], [class*="level" i]');
                if (expEl) experience = clean(expEl.textContent);

                push({
                    title,
                    description,
                    url,
                    registrationUrl,
                    location,
                    category,
                    employmentType,
                    experience,
                    company: 'Adex',
                    _via: jobCards.length > 0 ? 'card_with_job_href' : 'card_heading'
                });
            }

            // Last-resort fallback: same-origin job-ish anchors inside the openings section.
            if (out.length === 0 && section) {
                for (const a of Array.from(section.querySelectorAll('a[href]'))) {
                    const href = a.getAttribute('href');
                    if (!isJobHref(href)) continue;
                    const title = clean(a.textContent);
                    if (!title || title.length < 3 || title.length > 120) continue;
                    let url = LISTING_URL;
                    try { url = new URL(href, BASE).href; } catch (_) {}
                    push({
                        title,
                        description: null,
                        url,
                        registrationUrl: url,
                        location: null,
                        category: null,
                        employmentType: null,
                        experience: null,
                        company: 'Adex',
                        _via: 'anchor_only'
                    });
                }
            }

            return out;
        });

        const items = raw.map((r, i) => {
            const item = {
                id: `adex-2-${i}-${Date.now()}`,
                title: r.title || null,
                description: r.description || null,
                date: null,
                time: null,
                location: r.location || null,
                price: null,
                organizer: r.company || 'Adex',
                category: r.category || 'Job',
                tags: [],
                image: null,
                url: r.url || CAREER_URL,
                registrationUrl: r.registrationUrl || null,
                attendanceMode: r.location && /remote/i.test(r.location) ? 'remote' : 'in-person',
                source: 'adex-2',
                // jobs-specific extras
                company: r.company || 'Adex',
                companyUrl: 'https://adex.ltd',
                companyLogoUrl: null,
                employmentType: r.employmentType || null,
                applicationEndsRaw: null,
                salary: null,
                publishedAt: null,
                experience: r.experience || null,
                level: null,
                openings: null,
                responsibilities: null,
                requirements: null,
                skills: null
            };

            // Field status / evidence
            item.title_status = item.title ? 'extracted' : 'extraction_failed';
            if (item.title) item.title_evidence = r._via;

            item.company_status = 'extracted';
            item.company_evidence = 'adex.ltd/career is Adex\'s own careers page; site chrome ("A Driven Company", header logo) and footer copyright name Adex';

            item.url_status = 'extracted';
            item.url_evidence = r._via === 'anchor_only'
                ? 'same-origin job-ish anchor href inside [class*="openings"]'
                : r._via === 'card_with_job_href'
                    ? 'card anchor href inside [class*="openings"]'
                    : 'listing URL fallback (card had no job-specific link)';

            item.location_status = item.location ? 'extracted' : 'site_absent';
            if (!item.location) {
                item.location_evidence =
                    'searched [class*="location"], [class*="loc"], address inside openings card; site publishes office addresses (Nepal/UK/US/Latvia) in footer but no per-job location on the card';
            }

            item.description_status = item.description ? 'extracted' : 'extraction_failed';
            if (!item.description) {
                item.description_evidence =
                    'searched openings card <p>; no role body inline. Role description lives on a detail page whose link was not exposed by the listing card.';
            }

            item.employmentType_status = item.employmentType ? 'extracted' : 'site_absent';
            if (!item.employmentType) {
                item.employmentType_evidence =
                    'searched [class*="type"], [class*="employment"] and card text for full/part-time/contract/internship - none found';
            }

            item.applicationEndsRaw_status = 'site_absent';
            item.applicationEndsRaw_evidence = 'no apply-by date text in openings section or listing card';

            item.salary_status = 'site_absent';
            item.salary_evidence = 'no salary/compensation text on openings card';

            delete r._via;
            return item;
        });

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;
        if (items.length === 0) meta.atsEmpty = true;

        console.log(`  [adex-2] extracted ${items.length}`);

        return { items, meta };
    }
};