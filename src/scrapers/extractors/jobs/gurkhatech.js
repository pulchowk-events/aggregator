// src/scrapers/extractors/jobs/gurkhatech.js
// Site-specific extractor for gurkhatech.com/careers/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `meta` (38 instances) is HTML metadata.
//   - The "detail-link pattern" `/` (6 matches) is nav/social links only -
//     detailLinkCandidates are all /digital-marketing-in-nepal/* services
//     pages, NOT job detail pages.
//   - The "sample detail page" (H1.html-h1, FB CDN images) is the
//     company's FACEBOOK page - the dump mistakenly followed a social
//     link. Ignore those selectors.
//   - Category chips are nav menu items (Services, SEO, Meta Verification,
//     etc.), not role categories.
//   - The page IS the careers page (title "Vacancy in Nepal | Gurkha
//     Technology"; body contains "Thank you for your interest in joining
//     Gurkha Technology! We are always on the lookout for talented
//     individuals...").
//   - A "not-hiring.jpg" image is embedded - the site is currently in
//     "always looking, nothing open" mode. There are no job cards in the
//     DOM.
//
// Strategy: build a defensive extractor that:
//   1) parses JSON-LD JobPosting if ever added,
//   2) follows only real job-shaped anchors (/career/<slug>, /vacancy/.),
//      NOT service pages,
//   3) picks up role headings inside an "Openings"/"Vacancies" block,
//   4) otherwise returns [] gracefully - never invents items from the
//      marketing/legal copy.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const GURKHA_CAREERS_URL = 'https://gurkhatech.com/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [gurkhatech] Scraping Gurkha Technology careers...');

        meta.pagesVisited++;
        await page.goto(GURKHA_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [gurkhatech] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            // ---- 0) Explicit "not hiring" signal ----
            // If the page embeds the not-hiring asset with no other job
            // markers, stop early. This keeps us from inventing roles off
            // marketing copy.
            const bodyTxt = (document.body && document.body.innerText) || '';
            const notHiringImg = Array.from(document.querySelectorAll('img'))
                .some((img) => /not[-_]?hiring/i.test(img.getAttribute('src') || ''));
            const hasJobsMarker = /(open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacancies|current vacancies)/i.test(bodyTxt);

            // ---- 1) JSON-LD JobPosting ----
            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                let parsed;
                try { parsed = JSON.parse(s.textContent); }
                catch { continue; }
                const nodes = Array.isArray(parsed)
                    ? parsed
                    : (parsed && parsed['@graph']) || [parsed];
                for (const node of nodes) {
                    if (!node) continue;
                    const t = node['@type'];
                    const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                    if (!isJob) continue;
                    const title = clean(node.title || node.name);
                    if (!title) continue;
                    const url = node.url ? abs(node.url) : entryUrl;
                    const key = (title + '|' + url).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    let location = null;
                    const jl = node.jobLocation;
                    const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                    for (const l of arr) {
                        const addr = l && l.address;
                        const loc = addr && (addr.addressLocality || addr.addressRegion || addr.addressCountry);
                        if (loc) { location = typeof loc === 'string' ? loc : (loc.name || null); break; }
                    }

                    const hiring = node.hiringOrganization;
                    const organizer = (hiring && (hiring.name || hiring)) || 'Gurkha Technology';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `gurkhatech-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Gurkha Technology',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'gurkhatech',
                    });
                }
            }

            // If there's no jobs marker and no JSON-LD postings, avoid
            // misclassifying service pages as jobs. Skip stage 2/3 in that
            // case - the "not-hiring" state is explicit.
            if (out.length === 0 && !hasJobsMarker && notHiringImg) {
                return out;
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude /digital-marketing-in-nepal/* service pages and any
            // other obviously non-job routes.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|apply)\/[^/?#]+/i;
            const excludeRe = /(digital-marketing-in-nepal|meta-verification-in-nepal|facebook-boosting-in-nepal|about-gurkha-technology|blog|resources|contact|privacy|terms)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer, .mega-menu, .sub-menu')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                if (/^https?:\/\/(www\.)?(facebook|instagram|twitter|x|linkedin|github|behance)\./i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `gurkhatech-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Gurkha Technology',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'gurkhatech',
                });
            }

            // ---- 3) Role headings inside an "Openings"/"Vacancies" block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies)|current vacancies)/i;
            const marketingHeadingRe = /^(thank you for your interest|we are always|why work|benefits|perks|about (us|gurkha)|our culture|our values)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .vacancy, .position, .opening').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .vacancy-title, .position-title, .opening-title'
                )) {
                    if (el.closest('nav, header, footer')) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const key = (title + '|' + entryUrl).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const card = el.closest('li, article, div') || el.parentElement;
                    const card2 = (card && openingsBlock.contains(card)) ? card : el.parentElement;

                    const p = card2 ? card2.querySelector('p') : null;
                    const description = p ? stripHtml(p.textContent) : null;

                    const applyLink = card2 ? card2.querySelector(
                        'a[href^="mailto:"], a[href*="apply"], a[href*="career"], a[href*="vacancy"], a[href*="job"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    out.push({
                        id: `gurkhatech-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Gurkha Technology',
                        category: null,
                        tags: [],
                        image: null,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'gurkhatech',
                    });
                }
            }

            return out;
        }, GURKHA_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[gurkhatech] no open roles found (page is in "always looking / not hiring" state) - returning empty list');
        } else {
            console.log(`? [gurkhatech] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};