// src/scrapers/extractors/jobs/edigitalnepal.js
// Site-specific extractor for edigitalnepal.com/careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (5 matches) is nav/logo links, NOT
//     job detail links. detailLinkCandidates is empty.
//   - The "card wrapper" `script` (31 instances) is HTML metadata.
//   - cardCandidates are the brand logo container, culture/values cards
//     ("Innovation First", "Student Centric"), and contact-info list
//     items - no actual role rows captured.
//   - No JSON-LD anywhere on the page.
//   - The page IS the careers page (title "Careers - Digital Nepal"; body
//     opens with "careers / Careers / We are hiring! ... / View Open
//     Positions"). The open-roles section is likely rendered client-side
//     by Next.js and either had not hydrated by dump time, or the site
//     genuinely has no open roles right now.
//
// Strategy: wait + scroll for hydration, then extract defensively:
//   1) JSON-LD JobPosting
//   2) job-shaped detail anchors (/career/<id>, /jobs/<id>, ...)
//   3) role headings inside an "Open Positions" / "We're Hiring" block
//   4) card-shaped fallback: headings with sibling "Apply" control
// Return [] gracefully when nothing real exists.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EDIGITAL_CAREERS_URL = 'https://edigitalnepal.com/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [edigitalnepal] Scraping eDigital Nepal careers...');

        meta.pagesVisited++;
        await page.goto(EDIGITAL_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3500); // Next.js hydration + reveal animations

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [edigitalnepal] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Nudge reveal-on-scroll content (the site uses data-reveal="true").
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1200);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(600);
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
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Digital Nepal';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `edigitalnepal-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Digital Nepal',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'edigitalnepal',
                    });
                }
            }

            // ---- 2) Job-shaped detail anchors ----
            // Exclude the site's own marketing routes (/about-us, /products,
            // /blog, /faq, /in-medias, /career, /contact-us, /sms/login).
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(about-us|products?|blog|faq|in-medias|career|contact-us|sms|login|signup)(\/|$|#|\.)/i;
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

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `edigitalnepal-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Digital Nepal',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'edigitalnepal',
                });
            }

            // ---- 3) Role headings inside an Open-Positions-style block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies)|all openings|explore openings)/i;
            const marketingHeadingRe = /^(innovation first|student centric|shape the future|join a team|about our cult|our values|benefits|perks|why edigital|contact us|we are hiring!?$)/i;

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
                        'a[href^="mailto:"], a[href*="apply"], a[href*="career"], a[href*="job"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    const imgEl = card2 ? card2.querySelector('img') : null;
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `edigitalnepal-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Digital Nepal',
                        category: null,
                        tags: [],
                        image,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'edigitalnepal',
                    });
                }
            }

            // ---- 4) Card-shaped fallback: heading + sibling Apply control ----
            // Covers the case where role cards exist but no "Open Positions"
            // heading anchors them. Very conservative - requires an explicit
            // apply control on the same card.
            const skipHdrRe = /^(innovation first|student centric|home|about us|products|blog|faq|in medias|career|contact us|login|digital nepal)$/i;
            for (const h of document.querySelectorAll('h3, h4')) {
                if (h.closest('nav, header, footer')) continue;
                const title = clean(h.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (skipHdrRe.test(title)) continue;
                if (marketingHeadingRe.test(title)) continue;

                const card = h.closest('div, li, article');
                if (!card) continue;
                const ctrls = Array.from(card.querySelectorAll('a, button'));
                const applyCtrl = ctrls.find((c) => /^apply( now)?$|view (role|details|job)|read more/i.test((c.textContent || '').trim()));
                if (!applyCtrl) continue;

                const key = (title + '|' + entryUrl).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                let href = null;
                if (applyCtrl.tagName === 'A') {
                    const raw = applyCtrl.getAttribute('href') || '';
                    if (!/^(tel:|mailto:)/i.test(raw)) href = abs(raw);
                    else href = raw; // keep mailto: as registrationUrl
                }

                const p = card.querySelector('p');
                const description = p ? stripHtml(p.textContent) : null;

                out.push({
                    id: `edigitalnepal-${now}-${rand()}`,
                    title,
                    description,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Digital Nepal',
                    category: null,
                    tags: [],
                    image: null,
                    url: (href && !/^mailto:/i.test(href)) ? href : entryUrl,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'edigitalnepal',
                });
            }

            return out;
        }, EDIGITAL_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[edigitalnepal] no scrapeable open roles found - returning empty list');
        } else {
            console.log(`? [edigitalnepal] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};