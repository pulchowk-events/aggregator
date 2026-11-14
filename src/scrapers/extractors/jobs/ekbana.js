// src/scrapers/extractors/jobs/ekbana.js
// Site-specific extractor for careers.ekbana.com.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (5 matches) is nav/logo links only.
//     detailLinkCandidates is empty - no per-job detail hrefs were seen.
//   - The "card wrapper" `meta` (15 instances) is HTML metadata.
//   - cardCandidates only caught nav items; the actual job cards were not
//     matched by the dump's generic heuristics.
//   - HOWEVER, the bodySnippet confirms job cards ARE in the static DOM:
//       "Showing 1 - 1 of 1 jobs
//        Mid-Level UI/UX Designer
//        Jwagal, Lalitpur Nepal
//        Designer
//        6 days remaining
//        Join us as a Mid-Level UI/UX Designer ..."
//     That gives us two usable, evidence-anchored signals:
//       (a) a "Showing X - Y of N jobs" summary line - perfect empty-list
//           detector;
//       (b) a per-card signature of "<job title>, <location>, <category>,
//           <N days remaining>" - we use "days remaining" as a robust card
//           locator and climb from it to the enclosing card.
//   - The listing text includes the description, so no detail navigation
//     is required (we still try a job-detail href if the card exposes one).
//   - No pagination evidence - skip pagination loops.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EKBANA_JOBS_URL = 'https://careers.ekbana.com/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [ekbana] Scraping EKbana careers...');

        meta.pagesVisited++;
        await page.goto(EKBANA_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [ekbana] page looks blocked/captcha - bailing out');
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

            // ---- Empty-listing detection: "Showing X - Y of N jobs" ----
            const bodyTxt = (document.body && document.body.innerText) || '';
            const showingM = bodyTxt.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+jobs?/i);
            const totalJobs = showingM ? parseInt(showingM[3], 10) : null;
            if (totalJobs === 0) return out;

            // ---- 1) JSON-LD JobPosting (defensive - none expected) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'EKbana';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `ekbana-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'EKbana',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'ekbana',
                    });
                }
            }

            // ---- 2) Primary: cards located via "N days remaining" marker ----
            // Anchor every visible occurrence of "<N> day(s) remaining" to the
            // nearest card-shaped ancestor. This matches the evidence body's
            // per-card signature exactly.
            const remainingRe = /\b\d+\s+days?\s+remaining\b/i;
            const remainingNodes = Array.from(document.querySelectorAll('body *'))
                .filter((el) => {
                    if (el.children.length > 0) return false; // leaf text only
                    return remainingRe.test(el.textContent || '');
                });

            for (const rn of remainingNodes) {
                // Climb to a card-like ancestor that also holds a heading.
                let card = rn.parentElement;
                let heading = null;
                for (let i = 0; i < 6 && card && card !== document.body; i++) {
                    const h = card.querySelector('h1, h2, h3, h4, h5, [class*="job-title"], [class*="title"]');
                    if (h && clean(h.textContent)) { heading = h; break; }
                    card = card.parentElement;
                }
                if (!card || card === document.body || !heading) continue;

                const title = clean(heading.textContent);
                if (!title || title.length < 2 || title.length > 140) continue;

                const key = title.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                // Location: any sibling text that looks like "City, Country".
                const cardTxt = card.textContent || '';
                const locM = cardTxt.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+(?:\s+[A-Z][A-Za-z]+)?)/);
                const location = locM ? clean(locM[1]) : null;

                // Category: a short uppercase/label-like chip near the title
                // (e.g. "Designer"). Look for elements with small text whose
                // content is 1-3 words and not the title/location.
                let category = null;
                for (const el of card.querySelectorAll('span, small, div, p')) {
                    if (el.children.length > 0) continue;
                    const t = clean(el.textContent);
                    if (!t) continue;
                    if (t === title) continue;
                    if (location && t === location) continue;
                    if (remainingRe.test(t)) continue;
                    if (t.length < 2 || t.length > 40) continue;
                    if (!/^[A-Za-z][A-Za-z &/-]+$/.test(t)) continue;
                    category = t;
                    break;
                }

                // Description: the longest <p> inside the card.
                let description = null;
                let bestLen = 0;
                for (const p of card.querySelectorAll('p')) {
                    const t = stripHtml(p.textContent);
                    if (!t) continue;
                    if (t.length > bestLen) { bestLen = t.length; description = t; }
                }

                // Apply link: a real href inside the card (not tel:/mailto:).
                const applyLink = Array.from(card.querySelectorAll('a[href]'))
                    .find((a) => {
                        const raw = a.getAttribute('href') || '';
                        if (/^(tel:|mailto:)/i.test(raw)) return false;
                        return true;
                    });
                let href = null;
                if (applyLink) href = abs(applyLink.getAttribute('href'));

                // Thumbnail image if any.
                const imgEl = card.querySelector('img');
                const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                out.push({
                    id: `ekbana-${now}-${rand()}`,
                    title,
                    description: description || null,
                    date: null,
                    time: null,
                    location,
                    price: null,
                    organizer: 'EKbana',
                    category,
                    tags: [],
                    image,
                    url: href || entryUrl,
                    registrationUrl: href || entryUrl,
                    attendanceMode: null,
                    source: 'ekbana',
                });
            }

            // ---- 3) Fallback: direct job-detail anchors ----
            // Only if step 2 found nothing and no explicit "Showing...jobs"
            // count suggests zero.
            if (out.length === 0 && totalJobs !== 0) {
                const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
                const excludeRe = /\/(about-internship|about-us|blog|contact|life-at|activities)(\/|$|#|\.)/i;
                for (const a of document.querySelectorAll('a[href]')) {
                    if (a.closest('nav, header, footer')) continue;
                    const raw = a.getAttribute('href') || '';
                    if (/^(tel:|mailto:)/i.test(raw)) continue;
                    const href = abs(raw);
                    if (!href) continue;
                    if (!jobHrefRe.test(href)) continue;
                    if (excludeRe.test(href)) continue;

                    const title = clean(a.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    out.push({
                        id: `ekbana-${now}-${rand()}`,
                        title,
                        description: null,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'EKbana',
                        category: null,
                        tags: [],
                        image: null,
                        url: href,
                        registrationUrl: href,
                        attendanceMode: null,
                        source: 'ekbana',
                    });
                }
            }

            return out;
        }, EKBANA_JOBS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[ekbana] no open jobs found - returning empty list');
        } else {
            console.log(`? [ekbana] extracted ${items.length} job(s)`);
        }

        return { items, meta };
    },
};