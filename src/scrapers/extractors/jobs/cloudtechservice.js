// src/scrapers/extractors/jobs/cloudtechservice.js
// Site-specific extractor for cloudtechservice.com/careers/.
// See ../README.md for the contract.
//
// KEY FINDING FROM THE EVIDENCE DUMP:
//   - The page IS the careers page (title "Careers | CloudTechService";
//     body opens with "WE ARE HIRING / Join Our Team...").
//   - The bodySnippet literally reads: "CURRENT OPPORTUNITIES / Open
//     Positions / There are no open positions right no..." - the site
//     currently has ZERO open roles. So the correct behaviour is to
//     return an empty list, not to throw.
//   - The detected "detail-link pattern" `/services` (7 matches) points at
//     product/services pages, NOT job detail links. detailLinkCandidates
//     is empty. The detected "card wrapper" `path` (58) is inline SVG.
//   - No JobPosting JSON-LD exists (only ProfessionalService/WebSite/
//     WebPage/Person/Article).
//
// Strategy: still parse defensively in case the site adds roles later
// (JSON-LD JobPosting  job-shaped detail anchors  role headings inside
// the #cr-positions block). If none are found, return [] gracefully.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CLOUDTECH_CAREERS_URL = 'https://cloudtechservice.com/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [cloudtechservice] Scraping CloudTechService careers...');

        meta.pagesVisited++;
        await page.goto(CLOUDTECH_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [cloudtechservice] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll to the open-positions anchor if present so any
        // lazy-rendered cards are in the DOM before we harvest.
        try {
            await page.evaluate(() => {
                const target = document.querySelector('#cr-positions') ||
                    Array.from(document.querySelectorAll('h1, h2, h3'))
                        .find((h) => /open positions/i.test(h.textContent || ''));
                if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
            });
            await delay(1200);
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

            // ---- Early exit: "no open positions" banner ----
            const bodyTxt = (document.body && document.body.innerText) || '';
            const explicitlyEmpty = /no open positions( right now)?/i.test(bodyTxt);

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
                    const organizer = (hiring && (hiring.name || hiring)) || 'CloudTechService';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `cloudtechservice-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'CloudTechService',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'cloudtechservice',
                    });
                }
            }

            // If the site says "no open positions", stop here - nothing else
            // should be invented from marketing sections.
            if (explicitlyEmpty && out.length === 0) return out;

            // ---- 2) Job-shaped detail anchors ----
            // Exclude /services, /engage, /about-us, /contact-us, /careers
            // itself - those are site routes, not job detail links.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services?|engage|about-us|contact-us|blog|case-studies|news)(\/|$|#|\.)/i;
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
                    id: `cloudtechservice-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'CloudTechService',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'cloudtechservice',
                });
            }

            // ---- 3) Role headings inside #cr-positions or an "Open Positions" block ----
            const openingsHeadingRe = /(open positions?|current opportunities|current openings?|open roles?|we['']?re hiring|join our team|job openings?|vacanc(?:y|ies))/i;
            const marketingHeadingRe = /^(social security|working days|benefits|perks|why |about |nepal$|usa$|join our team and)/i;

            let openingsBlock = document.querySelector('#cr-positions');
            if (!openingsBlock) {
                for (const h of document.querySelectorAll('h1, h2, h3')) {
                    if (h.closest('nav, header, footer')) continue;
                    if (!openingsHeadingRe.test(h.textContent || '')) continue;
                    let container = h.parentElement;
                    for (let i = 0; i < 4 && container && container !== document.body; i++) {
                        if (container.querySelectorAll('h3, h4, .job, .job-card, .position, .cr-job-card').length > 0) {
                            openingsBlock = container;
                            break;
                        }
                        container = container.parentElement;
                    }
                    if (openingsBlock) break;
                }
            }

            if (openingsBlock) {
                const roleEls = openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .cr-job-title, .position-title, .opening-title, .card-title'
                );
                for (const el of roleEls) {
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
                        id: `cloudtechservice-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'CloudTechService',
                        category: null,
                        tags: [],
                        image,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'cloudtechservice',
                    });
                }
            }

            return out;
        }, CLOUDTECH_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[cloudtechservice] no open positions found - returning empty list');
        } else {
            console.log(`? [cloudtechservice] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};