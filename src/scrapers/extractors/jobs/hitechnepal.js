// src/scrapers/extractors/jobs/hitechnepal.js
// Site-specific extractor for hitechnepal.com.np/careers.html.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/solutions.html` (19 matches) is the
//     Solutions nav page (an anchor target), NOT a job detail URL.
//     detailLinkCandidates is empty.
//   - The "card wrapper" `meta` (16 instances) is HTML metadata.
//   - The sample detail page (/solutions.html) is a product page; its
//     H1.hw ("Software, built your way.") is marketing copy, not a job
//     title. Ignore that selector for jobs.
//   - cardCandidates are the Products/Solutions nav columns and product
//     link lists - no job rows captured.
//   - The page IS the careers page (title: "Software Jobs in Kathmandu |
//     Careers at HiTech"; body ends with an explicit
//     "OPEN POSITIONS / Roles at HiTech. / Technical Pr." section, and
//     a "Send your CV" CTA). So open roles ARE on the page but the dump's
//     generic heuristics missed the card DOM.
//
// Strategy: extract defensively:
//   1) JSON-LD JobPosting (none present today, defensive)
//   2) real job-shaped anchors (/careers/<slug>, /jobs/<slug>, etc.)
//   3) role headings inside the "OPEN POSITIONS" / "Roles at HiTech"
//      block, anchored via that exact phrase in the evidence.
//   4) card fallback: heading + nearby "Apply"/"Send CV" control, with a
//      strict marketing-heading exclusion list so we never emit product
//      or section headers as jobs.
// Return [] gracefully if the roles section is empty (the page may only
// have a "Send your CV" mailto and nothing else).

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const HITECH_CAREERS_URL = 'https://www.hitechnepal.com.np/careers.html';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [hitechnepal] Scraping HiTech Nepal careers...');

        meta.pagesVisited++;
        await page.goto(HITECH_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [hitechnepal] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll to the OPEN POSITIONS block so any lazy content is rendered.
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('h1, h2, h3, p, div'));
                const target = els.find((el) => el.children.length === 0
                    && /open positions/i.test(el.textContent || ''));
                if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
                else window.scrollTo(0, document.body.scrollHeight);
            });
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'HiTech Nepal';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `hitechnepal-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'HiTech Nepal',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'hitechnepal',
                    });
                }
            }

            // ---- 2) Real job-shaped detail anchors ----
            // Exclude all the site's product / solution / partner /
            // contact / careers-listing routes.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply)\/[^/?#]+/i;
            const excludeRe = /(solutions?|products?|partners?|company|support|contact|careers\.html|about|blog|privacy|terms)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
                if (/wa\.me|tivoraerp\.com/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?|send (your )?cv)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `hitechnepal-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'HiTech Nepal',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'hitechnepal',
                });
            }

            // ---- 3) Role headings inside "OPEN POSITIONS" block ----
            // Evidence body ends with "OPEN POSITIONS / Roles at HiTech."
            // Anchor to that block and pick up role headings.
            const openingsHeadingRe = /^(open positions?|roles? at hitech|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies))$/i;
            const marketingHeadingRe = /^(build business software in nepal|see our open positions|send your cv|products|solutions|partners|company|support|careers|contact|request a demo|build|software, built your way|from first call|erp|application software|customized software|custom mobile applications|e-commerce|got a new challenge|get a call back)$/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test((h.textContent || '').trim())) continue;
                let container = h.parentElement;
                for (let i = 0; i < 5 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .role, .opening, .position').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .role-title, .position-title, .opening-title'
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
                        'a[href^="mailto:"], a[href*="apply"], a[href*="career"], a[href*="job"], a[href*="role"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    // Fallback: keep the site's CV mailto so registrationUrl
                    // is useful even if the role itself has no apply link.
                    let registrationUrl = applyHref;
                    if (!registrationUrl) {
                        const cv = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
                            .find((a) => /send (your )?cv|careers?@/i.test(a.textContent || ''));
                        if (cv) registrationUrl = cv.getAttribute('href');
                    }

                    out.push({
                        id: `hitechnepal-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'HiTech Nepal',
                        category: null,
                        tags: [],
                        image: null,
                        url: applyHref || entryUrl,
                        registrationUrl: registrationUrl || applyHref || entryUrl,
                        attendanceMode: null,
                        source: 'hitechnepal',
                    });
                }
            }

            return out;
        }, HITECH_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[hitechnepal] no open roles found - returning empty list');
        } else {
            console.log(`? [hitechnepal] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};