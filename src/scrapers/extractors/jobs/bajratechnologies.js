// src/scrapers/extractors/jobs/bajratechnologies.js
// Site-specific extractor for bajratechnologies.com/jobs.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (12 matches) is nav/logo links, NOT job
//     detail links. detailLinkCandidates is empty.
//   - The "card wrapper" `script` (22 instances) is HTML metadata, NOT cards.
//   - cardCandidates are tab nav items and FAQ headings - no job rows.
//   - The page DOES have a "Current Openings" H2 (heading dump), but the
//     job rows under it were not captured. So we extract defensively:
//     JSON-LD  href-pattern anchors  role headings inside the
//     "Current Openings" block (or any block whose heading says
//     "Openings"/"Jobs"). Return empty list if none found rather than
//     invent items.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const BAJRA_JOBS_URL = 'https://bajratechnologies.com/jobs';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [bajratechnologies] Scraping Bajra Technologies jobs...');

        meta.pagesVisited++;
        await page.goto(BAJRA_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3000); // Odoo site - let any AJAX job list settle

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [bajratechnologies] page looks blocked/captcha - bailing out');
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
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            // ---- 1) JSON-LD JobPosting (if present) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Bajra Technologies';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `bajratechnologies-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Bajra Technologies',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'bajratechnologies',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude nav/footer and the site's non-job routes.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services?|solutions?|about|contactus|products?|bajra-ai|ai|blog|case-studies)(\/|$|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer, .bjr-nav')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `bajratechnologies-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Bajra Technologies',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'bajratechnologies',
                });
            }

            // ---- 3) Role headings inside "Current Openings" block ----
            const openingsHeadingRe = /(current openings?|open positions?|open roles?|we['']?re hiring|vacanc(?:y|ies)|job openings?)/i;
            const marketingHeadingRe = /^(can['']?t find|frequently asked|faqs?$|contact us for|do you have what)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                // Climb to a container that holds other headings (role items).
                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-item, .opening').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                const candidates = openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .job_position, .opening-title, .card-title'
                );
                for (const el of candidates) {
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
                        id: `bajratechnologies-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Bajra Technologies',
                        category: null,
                        tags: [],
                        image,
                        url: entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'bajratechnologies',
                    });
                }
            }

            return out;
        }, BAJRA_JOBS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[bajratechnologies] no scrapeable open roles found - returning empty list');
        } else {
            console.log(`? [bajratechnologies] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};