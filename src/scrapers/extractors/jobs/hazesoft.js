// src/scrapers/extractors/jobs/hazesoft.js
// Site-specific extractor for hazesoft.co/careers/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `meta` (17 instances) is HTML metadata.
//   - The "detail-link pattern" `/` (8 matches) is nav/logo links; no real
//     job-detail hrefs appear in anchorGroups and detailLinkCandidates is
//     empty.
//   - The "sample detail page" in the dump is /services/ - a product page,
//     not a job detail. Its H1.hz-hero__heading ("Teams, not tickets.") is
//     marketing copy, not a job title. Ignore that selector.
//   - cardCandidates are culture "W.1/W.2/W.3" stage blocks, footer nav,
//     and interview-process steps ("Intro call - 30 min") - no roles.
//   - BUT the page IS the careers page (title: "Careers - Software
//     Engineering Jobs in Kathmandu - Hazesoft"; body: "CAREERS / Stay on
//     hard problems."). And there is an explicit CTA
//     <a class="hz-btn hz-btn--lg" href="#roles">Open roles </a>
//     - so open roles ARE on the page under the #roles anchor and were
//     simply not captured by the dump's generic heuristics (likely
//     below-the-fold or client-rendered).
//
// Strategy: navigate, dismiss nothing (no cookie gate), scroll to #roles
// to trigger lazy content, then extract defensively:
//   1) JSON-LD JobPosting (if ever added)
//   2) real job-shaped anchors (/careers/<slug>, /jobs/<slug>, /roles/...)
//   3) role headings inside #roles or an "Open roles" block
//   4) heading + Apply-style control card fallback, explicitly excluding
//      the known false positives (hz-stages__col, hz-approach__col,
//      hz-trio__title, hz-services__title).
// Return [] gracefully when nothing real is found - never invent items
// from marketing copy.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const HAZESOFT_CAREERS_URL = 'https://hazesoft.co/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [hazesoft] Scraping Hazesoft careers...');

        meta.pagesVisited++;
        await page.goto(HAZESOFT_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [hazesoft] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Navigate to #roles (the explicit "Open roles " CTA target) so any
        // below-fold or lazy-rendered roles section is in view.
        try {
            await page.evaluate(() => {
                const target = document.querySelector('#roles');
                if (target && target.scrollIntoView) {
                    target.scrollIntoView({ block: 'start' });
                } else {
                    window.scrollTo(0, document.body.scrollHeight);
                }
            });
            await delay(1500);
            // A second pass for infinite-scroll/IntersectionObserver patterns.
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1000);
        } catch (e) { /* best-effort */ }

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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Hazesoft';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `hazesoft-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Hazesoft',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'hazesoft',
                    });
                }
            }

            // ---- 2) Real job-shaped detail anchors ----
            // Exclude /services/, /applied-ai/, /our-work/, /request-a-quote/,
            // /about/, /blog/, /contact/ and other site routes.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services?|applied-ai|our-work|our-approach|request-a-quote|about|blog|contact|privacy|terms|case-studies)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                // Skip pure in-page anchors (like the "Open roles " CTA).
                if (/^#/.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?|open roles?)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `hazesoft-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Hazesoft',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'hazesoft',
                });
            }

            // ---- 3) Role headings inside #roles / Open roles block ----
            const openingsHeadingRe = /(open roles?|open positions?|current openings?|we['']?re hiring|job openings?|vacanc(?:y|ies)|all roles|roles we['']?re hiring for)/i;
            const marketingHeadingRe = /^(stay on hard problems|one team|ai does|small senior|fixed team|your ip|exit-ready|teams, not tickets|intro call|technical deep|product engineering|applied ai|platform & data|legacy moderni[sz]ation)/i;

            let openingsBlock = document.querySelector('#roles');
            if (!openingsBlock) {
                for (const h of document.querySelectorAll('h1, h2, h3')) {
                    if (h.closest('nav, header, footer')) continue;
                    if (!openingsHeadingRe.test(h.textContent || '')) continue;
                    let container = h.parentElement;
                    for (let i = 0; i < 4 && container && container !== document.body; i++) {
                        if (container.querySelectorAll('h3, h4, .job, .job-card, .role, .opening, .position').length > 0) {
                            openingsBlock = container;
                            break;
                        }
                        container = container.parentElement;
                    }
                    if (openingsBlock) break;
                }
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .role-title, .position-title, .opening-title'
                )) {
                    if (el.closest('nav, header, footer')) continue;
                    // Skip the known non-role decorations we saw in the dump.
                    if (el.classList && (
                        el.classList.contains('hz-stages__title') ||
                        el.classList.contains('hz-approach__title') ||
                        el.classList.contains('hz-trio__title') ||
                        el.classList.contains('hz-services__title')
                    )) continue;

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
                        'a[href^="mailto:"], a[href*="apply"], a[href*="careers"], a[href*="roles"], a[href*="job"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    out.push({
                        id: `hazesoft-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Hazesoft',
                        category: null,
                        tags: [],
                        image: null,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'hazesoft',
                    });
                }
            }

            return out;
        }, HAZESOFT_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[hazesoft] no open roles found (roles section may be empty or client-rendered) - returning empty list');
        } else {
            console.log(`? [hazesoft] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};