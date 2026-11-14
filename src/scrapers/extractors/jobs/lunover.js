// src/scrapers/extractors/jobs/lunover.js
// Site-specific extractor for lunover.com/careers/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `meta` (25) is HTML metadata.
//   - The "detail-link pattern" `/` (6) is nav/logo + in-page hash anchors
//     (#careers-at-lunover, #why-work-with-us). Not job-detail URLs.
//   - All `detailLinkCandidates` are /services/* product pages - clearly
//     not job detail. detailLinkCandidates should be ignored for jobs.
//   - cardCandidates are the footer "Company"/"Services" columns, an
//     in-page anchor heading ("Careers at Lunover"), marketing copy
//     ("We build more than websites..."), and footer nav items - no
//     role cards.
//   - The page IS the careers page (title: "Careers at Lunover"; body:
//     "Careers / Join a team that builds digital products for clients
//     around the world. See open roles at Lunover. / Careers at Lunover
//     / We build more than websites..."). It is a Next.js app; the
//     open-roles list is either empty right now or rendered client-side
//     and not captured by the dump.
//
// Strategy: extract defensively -
//   1) JSON-LD JobPosting (if ever added)
//   2) real job-detail anchors (/careers/<slug>, /jobs/<slug>,
//      /open-roles/<slug>) - explicitly excluding /services/*, /about,
//      /contact, /case-studies, /blog
//   3) role headings inside a "Careers at Lunover"/"Open roles" block
//   4) heading + sibling Apply control card fallback
// Return [] gracefully when nothing real is found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const LUNOVER_CAREERS_URL = 'https://www.lunover.com/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [lunover] Scraping Lunover careers...');

        meta.pagesVisited++;
        await page.goto(LUNOVER_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // Next.js hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [lunover] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll to #careers-at-lunover (the in-page anchor target) and
        // then to the bottom in case roles render lazily.
        try {
            await page.evaluate(() => {
                const target = document.querySelector('#careers-at-lunover');
                if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
                else window.scrollTo(0, document.body.scrollHeight);
            });
            await delay(1000);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(800);
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Lunover';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `lunover-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Lunover',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'lunover',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude /services/*, /about, /contact, /case-studies,
            // /blog, /np (locale), and hash-only anchors.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|open-roles?|roles?|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services?|about|contact|case-studies|blog|np|privacy|terms|work)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
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
                    id: `lunover-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Lunover',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'lunover',
                });
            }

            // ---- 3) Role headings inside a Careers/Open-Roles block ----
            const openingsHeadingRe = /(careers at lunover|open roles?|open positions?|current openings?|we['']?re hiring|job openings?|vacanc(?:y|ies)|join (the )?team)/i;
            const marketingHeadingRe = /^(we build more than|why work with us|company|services|about us|case studies|contact|book a call|careers$)/i;

            let openingsBlock = document.querySelector('#careers-at-lunover')?.parentElement || null;
            if (!openingsBlock) {
                for (const h of document.querySelectorAll('h1, h2, h3')) {
                    if (h.closest('nav, header, footer')) continue;
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

                    const card = el.closest('li, article, div') || el.parentElement;
                    if (!card) continue;

                    // Require either an Apply-style control or a job-role container.
                    const ctrl = Array.from(card.querySelectorAll('a, button'))
                        .find((c) => /^apply( now)?$|view (role|job|details?)|read more/i.test((c.textContent || '').trim()));
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
                        id: `lunover-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Lunover',
                        category: null,
                        tags: [],
                        image: null,
                        url,
                        registrationUrl: registrationUrl || url,
                        attendanceMode: null,
                        source: 'lunover',
                    });
                }
            }

            return out;
        }, LUNOVER_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[lunover] no open roles found - returning empty list');
        } else {
            console.log(`? [lunover] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};