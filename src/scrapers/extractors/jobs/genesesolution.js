// src/scrapers/extractors/jobs/genesesolution.js
// Site-specific extractor for genesesolution.com/careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `script` (12 instances) is HTML metadata
//     (reCAPTCHA loader, Next.js chunks), NOT job cards.
//   - Category chips are nav links (Products, Industries, Careers, About,
//     Leadership, Life at Genese, Contact) - no role categories.
//   - cardCandidates are the site footer's "Company" column and nav <li>s.
//   - detailLinkCandidates is empty - no /careers/<slug> links were seen.
//   - The page title ("Careers - Genese Solution") and body
//     ("CAREERS / Help build the future with us. / Open roles across
//     engineering, product, and operations.") confirm this IS the careers
//     page. The site is Next.js; open roles are likely rendered
//     client-side and were not captured in the dump, OR there are none
//     right now.
//
// Strategy: wait for hydration, then extract defensively:
//   1) JSON-LD JobPosting (if ever added)
//   2) real job-detail anchors (/careers/<slug>, /jobs/<slug>, ...)
//   3) role headings inside an "Open roles" / "We're hiring" block.
// Return [] gracefully when nothing real exists - do NOT invent items
// from the marketing copy.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const GENESE_CAREERS_URL = 'https://www.genesesolution.com/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [genesesolution] Scraping Genese Solution careers...');

        meta.pagesVisited++;
        await page.goto(GENESE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3000); // Next.js hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [genesesolution] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Nudge lazy sections in.
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1200);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(500);
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Genese Solution';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `genesesolution-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Genese Solution',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'genesesolution',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude /products, /industries, /about, /leadership, /careers,
            // /life-at-genese, /contact, /case-studies, /blog - all site routes.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(products?|industr(?:y|ies)|about|leadership|careers?|life-at-genese|contact|case-studies|blog|platforms|services|insights|training)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(get in touch|read more|apply( now)?|learn more|view (role|details))$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `genesesolution-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Genese Solution',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'genesesolution',
                });
            }

            // ---- 3) Role headings inside an "Open roles"-style block ----
            const openingsHeadingRe = /(open roles?|open positions?|current openings?|we['']?re hiring|job openings?|vacanc(?:y|ies)|all roles|join (the )?team)/i;
            const marketingHeadingRe = /^(help build|secure\. intelligent|culture|benefits|perks|life at|why genes|our values|ready to|subscribe|about|leadership)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .position, .opening, .role').length > 0) {
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
                        'a[href^="mailto:"], a[href*="apply"], a[href*="careers"], a[href*="job"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    const imgEl = card2 ? card2.querySelector('img') : null;
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `genesesolution-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Genese Solution',
                        category: null,
                        tags: [],
                        image,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'genesesolution',
                    });
                }
            }

            return out;
        }, GENESE_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[genesesolution] no open roles found - returning empty list');
        } else {
            console.log(`? [genesesolution] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};