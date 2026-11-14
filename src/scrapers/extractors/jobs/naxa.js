// src/scrapers/extractors/jobs/naxa.js
// Site-specific extractor for naxa.com.np/workwithus.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `meta` (19) is HTML metadata.
//   - The "detail-link pattern" `/` (6) is nav/logo links only.
//     detailLinkCandidates are all marketing routes (/portfolio/*,
//     /showcase/*, /events/*, /publications/*, /blogs/*) - NOT job
//     detail URLs.
//   - cardCandidates are footer widgets, nav <li>s, phone number spans,
//     and the "culture perks" grid cards
//     (`div.grid-lg-4.grid-md-6.grid-sm-12` with "Inclusive Work
//     Environment", etc.) - not jobs.
//   - No JSON-LD JobPosting.
//   - The page IS the careers / "Work with us" page (body opens
//     "WORK WITH US / At NAXA, we work on ideas; ideas that can provide
//     simple solutions to complex problems. / We work as a team to
//     generate, explore, build and valid."), but the dump body snippet is
//     truncated and no role cards are visible in the captured content.
//     The site is a React SPA (react-reveal grids, hash routing) so an
//     "open positions" block may exist below the fold or after hydration.
//
// Strategy: extract defensively -
//   1) JSON-LD JobPosting (if ever added)
//   2) real job-detail anchors (/careers/<slug>, /jobs/<slug>,
//      /workwithus/<slug>) - explicitly excluding /services, /portfolio,
//      /showcase, /events, /publications, /blogs, /about, /team, /geoai
//   3) role headings inside a "Work with us" / "Open roles" /
//      "Current openings" block, with an exclusion list for the known
//      culture/values headings from the dump.
// Return [] gracefully when nothing real is found - never emit culture
// cards or nav links as jobs.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const NAXA_CAREERS_URL = 'https://naxa.com.np/workwithus';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [naxa] Scraping NAXA Work-With-Us page...');

        meta.pagesVisited++;
        await page.goto(NAXA_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // React SPA hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [naxa] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll through the page so react-reveal blocks mount and any
        // below-fold openings are rendered.
        try {
            const height = await page.evaluate(() => document.body.scrollHeight);
            const steps = Math.min(8, Math.ceil(height / 800));
            for (let i = 0; i < steps; i++) {
                await page.evaluate((y) => window.scrollTo(0, y), i * 800);
                await delay(300);
            }
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(300);
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

            // ---- 1) JSON-LD JobPosting (defensive) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'NAXA';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `naxa-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'NAXA',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'naxa',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude all of NAXA's known non-job routes.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply|workwithus)\/[^/?#]+/i;
            const excludeRe = /\/(services?|portfolio|showcase|events?|publications?|blogs?|about|team|geoai|awards-and-achievements|contact|privacy|terms)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (!raw) continue;
                if (/^(tel:|mailto:|javascript:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
                // Skip the GEO AI cross-site link.
                if (/geoai\.naxa\.com\.np/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?|let['']?s talk)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `naxa-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'NAXA',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'naxa',
                });
            }

            // ---- 3) Role headings inside a Work-With-Us/Openings block ----
            const openingsHeadingRe = /(work with us|open positions?|open roles?|current openings?|we['']?re hiring|job openings?|vacanc(?:y|ies)|join (our|the) team|careers? at naxa|current opportunities?)/i;
            const marketingHeadingRe = /^(location matters!?|inclusive work environment|growth opportunities|work-life balance|team culture|learning & development|at naxa, we work on ideas|we work as a team|check out our pioneering|services$|portfolio$|company$|geoai$|events & media$|blogs$|let['']?s talk$|work with us$)/i;

            // Also exclude perks cards by their known wrapper classes.
            const isNonJobCard = (el) => {
                if (!el) return false;
                if (el.closest('.grid-col-wrap')) return true;       // culture perks
                if (el.closest('.footer-widget')) return true;        // footer
                if (el.closest('.react-reveal.grid-lg-6')) return true; // portfolio highlights
                if (el.closest('.focus-box')) return true;            // focus-area cards
                if (el.closest('.highlight-box')) return true;        // highlight-box cards
                return false;
            };

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (isNonJobCard(h)) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 5 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, article, .job, .job-card, .role, .opening, .position').length > 0) {
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
                    if (isNonJobCard(el)) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const card = el.closest('li, article, div') || el.parentElement;
                    if (!card) continue;

                    // Require either a real apply control or a job-role
                    // container - otherwise it's a culture/perks card.
                    const ctrl = Array.from(card.querySelectorAll('a, button'))
                        .find((c) => /^apply( now)?$|view (role|job|details?)|read more/i
                            .test((c.textContent || '').trim()));
                    const hasJobClass = card.matches('.job, .job-card, .role, .opening, .position') ||
                        !!card.closest('.job, .job-card, .role, .opening, .position');
                    if (!ctrl && !hasJobClass) continue;

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const p = card.querySelector('p');
                    const description = p ? stripHtml(p.textContent) : null;

                    let registrationUrl = null;
                    let url = entryUrl;
                    if (ctrl && ctrl.tagName === 'A') {
                        const raw = ctrl.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:)/i.test(raw) && !/^#/.test(raw)) {
                            const resolved = abs(raw);
                            if (resolved) {
                                registrationUrl = resolved;
                                try {
                                    if (new URL(resolved).origin === window.location.origin) url = resolved;
                                } catch (e) { /* keep entryUrl */ }
                            }
                        }
                    }

                    out.push({
                        id: `naxa-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'NAXA',
                        category: null,
                        tags: [],
                        image: null,
                        url,
                        registrationUrl: registrationUrl || url,
                        attendanceMode: null,
                        source: 'naxa',
                    });
                }
            }

            return out;
        }, NAXA_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[naxa] no open roles found on /workwithus - returning empty list (page is currently a culture/intro page with no listings)');
        } else {
            console.log(`? [naxa] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};