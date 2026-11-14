// src/scrapers/extractors/jobs/eminenceways.js
// Site-specific extractor for eminenceways.com/career.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/home` (3 matches) is the site's own
//     home-page nav link, NOT a job detail href. detailLinkCandidates is
//     empty.
//   - The "card wrapper" `meta` (14 instances) is HTML metadata.
//   - cardCandidates are footer widgets ("Our Location", "Pages") and nav
//     links - not job cards.
//   - The "detail title element" H1.homepage-three-title is the HOMEPAGE's
//     hero heading, not a job title - the dump visited /home as the
//     "sample detail page" by mistake.
//   - The page IS the careers page (title "Career - Eminence Ways ...";
//     body: "CAREER / HOME CAREER / Join Our Team! / We're always
//     searching for amazing people... Take a look at our current
//     openings. / Business Development Associate / Our Location").
//   - So the current-openings list is inline on this page. The only
//     evidence-backed job name is "Business Development Associate" and it
//     appears just before the "Our Location" footer widget.
//
// Strategy: extract defensively and conservatively -
//   1) JSON-LD JobPosting (none expected)
//   2) job-shaped detail anchors (/career/<id>, /jobs/<id>, ...)
//   3) role-shaped headings between the "current openings" intro and the
//      footer/location block. Anchor to the "Take a look at our current
//      openings" intro that the evidence gives us verbatim.
// Return [] gracefully when nothing is found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EMINENCE_CAREERS_URL = 'https://eminenceways.com/career';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [eminenceways] Scraping Eminence Ways careers...');

        meta.pagesVisited++;
        await page.goto(EMINENCE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [eminenceways] page looks blocked/captcha - bailing out');
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

            // ---- 1) JSON-LD JobPosting (none expected, defensively handled) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Eminence Ways';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `eminenceways-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Eminence Ways',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'eminenceways',
                    });
                }
            }

            // ---- 2) Real job-shaped detail anchors ----
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(home|about|services|projects?|blog|gallery|contact)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer, .navbar, .nav-item')) continue;
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
                    id: `eminenceways-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Eminence Ways',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'eminenceways',
                });
            }

            // ---- 3) Inline role headings after the "current openings" intro ----
            // Evidence body: "We're always searching for amazing people to
            // join our team. Take a look at our current openings.
            // Business Development Associate / Our Location / ..."
            //
            // We locate the "current openings" / "Join Our Team" intro text,
            // then walk its following siblings (up to the "Our Location"
            // footer widget) and capture any heading-like element that
            // doesn't look like site chrome.
            const introRe = /(take a look at our current openings|join our team|current openings|open positions?|open roles?|we['']?re hiring)/i;
            const stopRe = /^(our location|pages|about us|quick links|contact us|follow us|newsletter)/i;
            const chromeRe = /^(home|about|services|projects?|blog|gallery|career|contact( us)?|our team|nav.*)$/i;

            // Find an element whose text (leaf-only) matches the intro.
            let anchorEl = null;
            for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, p, div, span')) {
                if (el.children.length > 0) continue;
                const t = clean(el.textContent);
                if (!t) continue;
                if (t.length > 400) continue;
                if (introRe.test(t)) { anchorEl = el; break; }
            }

            if (anchorEl) {
                // Walk the DOM forward from the intro, collecting candidate
                // role titles until we hit the footer/location block.
                const collect = (root) => {
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
                        acceptNode(node) {
                            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) {
                                return NodeFilter.FILTER_REJECT;
                            }
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    });
                    const candidates = [];
                    let n;
                    while ((n = walker.nextNode())) {
                        const tag = n.tagName;
                        if (!['H1', 'H2', 'H3', 'H4', 'H5', 'A', 'STRONG', 'B'].includes(tag)) continue;
                        if (n.closest('.navbar, .nav-item, header, footer')) continue;
                        const t = clean(n.textContent);
                        if (!t || t.length < 3 || t.length > 140) continue;
                        if (chromeRe.test(t)) continue;
                        if (introRe.test(t)) continue;
                        if (stopRe.test(t)) break;
                        candidates.push({ el: n, text: t });
                    }
                    return candidates;
                };

                // Start from the intro's nearest ancestor that spans the
                // "openings" section (so we don't lose sibling headings that
                // live outside the intro's parent <p>).
                let scope = anchorEl.parentElement;
                for (let i = 0; i < 4 && scope && scope !== document.body; i++) {
                    if (scope.querySelectorAll('h1, h2, h3, h4, h5, a').length > 1) break;
                    scope = scope.parentElement;
                }
                const candidates = scope ? collect(scope) : [];

                for (const { el, text } of candidates) {
                    // Skip if it looks like a footer link.
                    if (el.closest('footer, .footer, .widget')) continue;
                    if (stopRe.test(text)) break;

                    const key = text.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // Prefer an href if the role is itself a link.
                    let href = null;
                    const linkEl = el.tagName === 'A' ? el : el.querySelector('a[href]');
                    if (linkEl) {
                        const raw = linkEl.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:)/i.test(raw)) href = abs(raw);
                    }

                    // Try to find a nearby description paragraph.
                    const card = el.closest('div, li, article, section') || el.parentElement;
                    let description = null;
                    if (card) {
                        let bestLen = 0;
                        for (const p of card.querySelectorAll('p')) {
                            const t = stripHtml(p.textContent);
                            if (t && t.length > bestLen && !/join our team|take a look|always searching/i.test(t)) {
                                bestLen = t.length; description = t;
                            }
                        }
                    }

                    out.push({
                        id: `eminenceways-${now}-${rand()}`,
                        title: text,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Eminence Ways',
                        category: null,
                        tags: [],
                        image: null,
                        url: href || entryUrl,
                        registrationUrl: href || entryUrl,
                        attendanceMode: null,
                        source: 'eminenceways',
                    });
                }
            }

            return out;
        }, EMINENCE_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[eminenceways] no open roles found - returning empty list');
        } else {
            console.log(`? [eminenceways] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};