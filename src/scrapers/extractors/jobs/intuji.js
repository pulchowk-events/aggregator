// src/scrapers/extractors/jobs/intuji.js
// Site-specific extractor for intuji.com/careers/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `script` (12) is HTML metadata.
//   - The "detail-link pattern" `/careers/` (3 matches) are in-page nav/
//     CTA anchors (#positions, #, /careers/), NOT separate job-detail URLs.
//     detailLinkCandidates is empty.
//   - The "sample detail page" (intuji.com/careers/#) is the SAME careers
//     page - confirming this is a single-page listing. Its H1 ("Design,
//     Build & Laugh! Be A Part Of Our Team") and H3 values "Innovative",
//     "Agile", "Transparent" are marketing copy; the actual role row is
//     H3 "DevOps Engineer" under H2 "Check Out These Opportunities!".
//   - cardCandidates include benefits ("Top-tier salary packages") and
//     value blocks - not jobs. We explicitly exclude them.
//
// Strategy (single-page):
//   1. Navigate + detectPageState.
//   2. Scroll to #positions (explicit "View Open Positions" CTA target)
//      or the "Check Out These Opportunities!" heading.
//   3. Anchor on that section and extract role headings (h3.mb-4 per
//      evidence, with h3/h4 fallback). For each role, grab description,
//      image, and any Apply link (including external ATS URLs).
//   4. If a role links to an external ATS (greenhouse/lever/workable/
//      bamboohr/recruitee etc.), keep that as registrationUrl and do NOT
//      crawl it - the target extractor is a different domain.
//   5. Return [] gracefully if no roles are found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const INTUJI_CAREERS_URL = 'https://intuji.com/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [intuji] Scraping Intuji careers...');

        meta.pagesVisited++;
        await page.goto(INTUJI_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // Next.js hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [intuji] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll to #positions (explicit CTA) and then to the bottom in
        // case the roles list is triggered by an IntersectionObserver.
        try {
            await page.evaluate(() => {
                const target = document.querySelector('#positions');
                if (target && target.scrollIntoView) {
                    target.scrollIntoView({ block: 'start' });
                } else {
                    const h = Array.from(document.querySelectorAll('h1, h2, h3'))
                        .find((el) => /check out these opportunities|open positions/i.test(el.textContent || ''));
                    if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start' });
                }
            });
            await delay(1200);
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

            // ---- 0) Locate the "Check Out These Opportunities" section ----
            const sectionHeadingRe = /(check out these opportunities|open positions?|current openings?|open roles?|we['']?re hiring)/i;
            let section = document.querySelector('#positions');
            if (!section) {
                for (const h of document.querySelectorAll('h1, h2, h3')) {
                    if (h.closest('nav, header, footer')) continue;
                    if (!sectionHeadingRe.test(h.textContent || '')) continue;
                    let container = h.parentElement;
                    for (let i = 0; i < 5 && container && container !== document.body; i++) {
                        if (container.querySelectorAll('h3, h4, article, .job, .job-card, .role, .opening, .position').length > 0) {
                            section = container;
                            break;
                        }
                        container = container.parentElement;
                    }
                    if (section) break;
                }
            }

            // Excluded headings - known marketing/value/benefit copy from
            // the dump that must not become job items.
            const exHdrRe = /^(design, build & laugh!?.*|what are our values\??|innovative$|agile$|transparent$|top-tier salary packages|work with notable global brands|benefits of a career with intuji|check out these opportunities!?$|our values$|our story$|our brand$)/i;

            // ---- 1) JSON-LD JobPosting (defensive - none present today) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Intuji';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `intuji-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Intuji',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'intuji',
                    });
                }
            }

            // ---- 2) Role headings in the opportunities section ----
            if (section) {
                // Prefer h3.mb-4 (confirmed in evidence: "DevOps Engineer").
                const preferred = section.querySelectorAll('h3.mb-4, h3.font-semibold, h3, h4');
                for (const el of preferred) {
                    if (el.closest('nav, header, footer')) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (exHdrRe.test(title)) continue;
                    if (sectionHeadingRe.test(title)) continue;

                    // Must not be one of the value cards - those sit inside
                    // div.relative.flex.flex-col.gap-6 wrappers and have
                    // class font-semibold. We require the role heading to
                    // live in a card with either a link or a sibling apply
                    // control - otherwise it's a value/benefit block.
                    const card = el.closest('article, li, div') || el.parentElement;
                    if (!card) continue;
                    const cardLinks = card.querySelectorAll('a[href]');
                    const hasApply = Array.from(cardLinks).some((a) =>
                        /apply|view (role|job|details?)|read more|learn more/i.test(a.textContent || ''));
                    const hasJobClass = card.matches('.job, .job-card, .role, .opening, .position') ||
                        !!card.closest('.job, .job-card, .role, .opening, .position');
                    if (!hasApply && !hasJobClass && cardLinks.length === 0) continue;

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // Description: longest <p> inside the card.
                    let description = null;
                    let bestLen = 0;
                    for (const p of card.querySelectorAll('p')) {
                        const t = stripHtml(p.textContent);
                        if (!t) continue;
                        if (t.length > bestLen) { bestLen = t.length; description = t; }
                    }

                    // Apply / registration URL.
                    let registrationUrl = null;
                    let url = entryUrl;
                    const applyLink = Array.from(cardLinks).find((a) =>
                        /apply|view (role|job|details?)|read more|learn more/i.test(a.textContent || ''))
                        || cardLinks[0];
                    if (applyLink) {
                        const raw = applyLink.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:)/i.test(raw) && !/^#/.test(raw)) {
                            const resolved = abs(raw);
                            if (resolved) {
                                registrationUrl = resolved;
                                // Only use as canonical url if it's same-origin
                                // (external ATS is only the apply link).
                                try {
                                    const u = new URL(resolved);
                                    if (u.origin === window.location.origin) url = resolved;
                                } catch (e) { /* keep entryUrl */ }
                            }
                        }
                    }

                    const imgEl = card.querySelector('img');
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    // Location hint: any "City, Country" pattern in card text.
                    let location = null;
                    const cardTxt = card.textContent || '';
                    const locM = cardTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);
                    if (locM) location = clean(locM[1]);

                    out.push({
                        id: `intuji-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location,
                        price: null,
                        organizer: 'Intuji',
                        category: null,
                        tags: [],
                        image,
                        url,
                        registrationUrl: registrationUrl || url,
                        attendanceMode: null,
                        source: 'intuji',
                    });
                }
            }

            return out;
        }, INTUJI_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[intuji] no open roles found - returning empty list');
        } else {
            console.log(`? [intuji] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};