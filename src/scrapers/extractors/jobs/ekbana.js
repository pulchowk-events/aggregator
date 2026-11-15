// src/scrapers/extractors/jobs/ekbana.js
// Site: https://careers.ekbana.com/  (EKCareer - EKbana's careers board)
// Verdict: CAREERS_PAGE.
//
// Corrections to the wizard's assumptions:
//   - Site type is SINGLE-PAGE-CARDS, not listing-to-detail. The detected
//     "/ (5 matches)" pattern is FALSE POSITIVE - those are nav links
//     (Home, Jobs, Blog). detailLinkCandidates was empty; the job card
//     carries title + location + category + "N days remaining" badge +
//     description excerpt directly. Body snippet confirms:
//       "Mid-Level UI/UX Designer / Jwagal, Lalitpur Nepal / Designer /
//        5 days remaining / Join us as a Mid-Level UI/UX Designer to ."
//   - "Card wrapper: meta" is site chrome.
//   - og:site_name is "EKCareer" but the page copy is "Explore Opportunities
//     at EKbana" and the parent brand is EKbana - company = "EKbana".
//   - Listing supports server-side sort (?sort=popular / ?sort=latest) and
//     pagination ("Showing 1 - 1 of 1 jobs"). We follow ?page=N, capped at 10.
//
// Traversal: paginated single-page-cards. One page.evaluate per page.
//
// Selector drift history:
//   2026-11-15: initial extraction. Anchor on the "Showing X - Y of Z jobs"
//                paginator line and on the "N days remaining" badge, which
//                is the most reliable per-card signal on this board.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EKBANA_BASE = 'https://careers.ekbana.com';
const EKBANA_LISTING = 'https://careers.ekbana.com/';
const EKBANA_COMPANY = 'Ekbana';
const MAX_PAGES = 10;

function deadlineFromDaysRemaining(text) {
    const m = text && text.match(/(\d+)\s*days?\s*remaining/i);
    if (!m) return null;
    const days = parseInt(m[1], 10);
    if (!Number.isFinite(days) || days < 0) return null;
    const d = new Date(Date.now() + days * 86400000);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseCardText(text) {
    const out = {};
    if (!text) return out;

    const employment = text.match(/\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary|Freelance)\b/i);
    if (employment) out.employmentType = employment[1].replace(/\s+/g, ' ');

    const mode = text.match(/\b(Remote|On-?site|Hybrid)\b/i);
    if (mode) out.attendanceMode = mode[1].toLowerCase().replace(/-/g, '');

    const level = text.match(/\b(Junior|Mid[- ]?Level|Senior|Lead|Principal|Entry[- ]?Level)\b/i);
    if (level) out.level = level[1].replace(/\s+/g, ' ');

    const experience = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\s*\+)?)/i);
    if (experience) out.experience = experience[1].trim();

    const openings = text.match(/(\d+)\s*(?:Openings?|positions?|vacanc(?:y|ies))/i);
    if (openings) out.openings = openings[1];

    // Explicit deadline if present; otherwise the "N days remaining" badge
    // is the only signal and is turned into an approximate date.
    const explicitDeadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    out.applicationEndsRaw = explicitDeadline
        ? explicitDeadline[1].trim()
        : deadlineFromDaysRemaining(text);

    const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];
        const seenIds = new Set();

        // ---- Stage 1: load listing ----
        try {
            meta.pagesVisited++;
            await loadPage(page, EKBANA_LISTING, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 600 + 400);
        } catch (err) {
            console.warn(`?? [ekbana] failed to load listing: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [ekbana] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('h1, h2, body', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // ---- Stage 2: paginate + harvest ----
        let pageIndex = 1;
        let totalDiscovered = 0;

        while (pageIndex <= MAX_PAGES) {
            const harvested = await page.evaluate(() => {
                const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

                // Read the paginator line "Showing X - Y of Z jobs".
                const bodyText = (document.body && document.body.innerText) || '';
                const rangeMatch = bodyText.match(/Showing\s+(\d+)\s*[--]\s*(\d+)\s+of\s+(\d+)\s+jobs?/i);
                const range = rangeMatch
                    ? { from: +rangeMatch[1], to: +rangeMatch[2], total: +rangeMatch[3] }
                    : null;

                // Find job-detail anchors (best case).
                const jobAnchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
                    const href = a.getAttribute('href') || '';
                    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return false;
                    if (a.closest('header, footer, nav')) return false;
                    // Careers boards typically use /jobs/slug, /job/slug, /careers/slug,
                    // or a query ?job=. - accept anything that looks like a job detail.
                    return /\/jobs?\/[^/?#]+|\/careers?\/[^/?#]+|[?&]job=/i.test(href);
                });

                // Locate job cards. Primary signal: "N days remaining" badge
                // (visible in the body snippet). Walk up to the card wrapper.
                const dayBadges = Array.from(document.querySelectorAll('*'))
                    .filter((el) => {
                        if (el.children && el.children.length > 0) return false; // leaf nodes only
                        const t = (el.textContent || '').trim();
                        return /^\d+\s*days?\s+remaining$/i.test(t);
                    });

                const out = [];
                const seen = new Set();

                const pickCardRoot = (startEl) => {
                    let node = startEl;
                    for (let i = 0; i < 6 && node; i++) {
                        const t = clean(node.innerText) || '';
                        const hasTitle = node.querySelector('h1, h2, h3, h4, a[href]');
                        if (t.length >= 40 && hasTitle) return node;
                        node = node.parentElement;
                    }
                    return startEl.parentElement;
                };

                const buildCard = (root, anchorHint) => {
                    if (!root) return null;
                    if (root.closest('header, footer, nav')) return null;

                    const h = root.querySelector('h1, h2, h3, h4');
                    const titleFromH = clean(h ? h.textContent : null);

                    const anchor = anchorHint || Array.from(root.querySelectorAll('a[href]')).find((a) => {
                        if (a.closest('header, footer, nav')) return false;
                        const href = a.getAttribute('href') || '';
                        return href && !href.startsWith('#') && !href.startsWith('mailto:');
                    });

                    const titleFromA = anchor ? clean(anchor.textContent) : null;
                    const title = titleFromH || titleFromA;
                    if (!title || title.length < 3 || title.length > 160) return null;

                    const text = clean(root.innerText) || '';
                    if (!text) return null;

                    let url = null;
                    if (anchor) {
                        try { url = anchor.href; } catch (_) { /* ignore */ }
                    }

                    const img = root.querySelector('img');
                    let image = null;
                    if (img) {
                        try { image = window.__resolveImageSrc(img); } catch (_) { /* ignore */ }
                    }

                    return { title, text, url, image };
                };

                // 1) Day-badge anchored cards (most reliable on this board).
                for (const badge of dayBadges) {
                    const root = pickCardRoot(badge);
                    const card = buildCard(root, null);
                    if (!card) continue;
                    const key = card.title + '|' + (card.url || '');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push(card);
                }

                // 2) Job-detail anchors (in case the badge was dropped).
                for (const a of jobAnchors) {
                    const root = a.closest('article, li, div');
                    const card = buildCard(root, a);
                    if (!card) continue;
                    const key = card.title + '|' + (card.url || '');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push(card);
                }

                // Detect next-page link.
                const nextLink = Array.from(document.querySelectorAll('a[href]')).find((a) => {
                    const t = (a.textContent || '').trim();
                    const rel = (a.getAttribute('rel') || '').toLowerCase();
                    const href = a.getAttribute('href') || '';
                    if (!href) return false;
                    if (/next/i.test(rel) || /^next\b/i.test(t)) return true;
                    return false;
                });

                let nextUrl = null;
                if (nextLink) {
                    try { nextUrl = nextLink.href; } catch (_) { /* ignore */ }
                }
                // Fallback: derive from ?page=N when range says there's more.
                if (!nextUrl && range && range.to < range.total) {
                    try {
                        const u = new URL(window.location.href);
                        const cur = parseInt(u.searchParams.get('page') || '1', 10);
                        u.searchParams.set('page', String(cur + 1));
                        nextUrl = u.href;
                    } catch (_) { /* ignore */ }
                }

                return { cards: out, range, nextUrl, pageUrl: window.location.href };
            });

            const cards = harvested.cards || [];
            meta.listingHits += cards.length;
            totalDiscovered += cards.length;
            safeDiscovered(progress, cards.length);

            // Site-wide location fallback (footer / contact).
            let siteLocation = null;
            try {
                siteLocation = await page.evaluate(() => {
                    const addr = document.querySelector('address, [class*="address"]');
                    if (addr) {
                        const t = (addr.textContent || '').replace(/\s+/g, ' ').trim();
                        if (t) return t;
                    }
                    const m = (document.body.innerText || '').match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Jwagal|Nepal)\b/i);
                    return m ? m[1] : null;
                });
            } catch (e) { /* ignore */ }

            for (const card of cards) {
                try {
                    const parsed = parseCardText(card.text);
                    const key = card.url || card.title;
                    if (seenIds.has(key)) { safeUnitDone(progress); continue; }
                    seenIds.add(key);

                    // Best-effort location: first line of card after the title that
                    // contains a place token; else site fallback.
                    const locMatch = (card.text || '').match(/\b([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)?,\s*[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
                    const location = locMatch ? locMatch[1] : siteLocation;

                    items.push({
                        id: `ekbana-${(card.url && card.url.split('/').filter(Boolean).pop()) || card.title.toLowerCase().replace(/\s+/g, '-')}`,
                        title: card.title,
                        company: EKBANA_COMPANY,
                        company_status: 'extracted',
                        company_evidence: 'page copy "Explore Opportunities at EKbana"; brand EKbana',
                        description: card.text || null,
                        description_status: card.text ? 'extracted' : 'extraction_failed',
                        description_evidence: card.text
                            ? 'inline job-card text (careers board publishes description excerpt on the listing card)'
                            : 'card text empty',
                        date: null,
                        time: null,
                        location: location || null,
                        location_status: location ? 'extracted' : 'site_absent',
                        location_evidence: locMatch
                            ? 'city/region token inside job card text'
                            : (siteLocation
                                ? 'site-wide address block / Nepal token (no per-card location published)'
                                : 'no location token in card and no address element on page'),
                        price: null,
                        organizer: EKBANA_COMPANY,
                        category: null,
                        tags: [parsed.employmentType, parsed.level, parsed.attendanceMode].filter(Boolean),
                        image: card.image || null,
                        image_status: card.image ? 'extracted' : 'site_absent',
                        image_evidence: card.image
                            ? 'first img inside job card'
                            : 'no img inside job card',
                        url: card.url || harvested.pageUrl || EKBANA_LISTING,
                        registrationUrl: card.url || harvested.pageUrl || EKBANA_LISTING,
                        attendanceMode: parsed.attendanceMode || null,
                        source: 'ekbana',
                        employmentType: parsed.employmentType || null,
                        employmentType_status: parsed.employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: parsed.employmentType
                            ? 'Full/Part/Contract/Internship token in card text'
                            : 'no employment-type token in card text',
                        applicationEndsRaw: parsed.applicationEndsRaw || null,
                        applicationEnds_status: parsed.applicationEndsRaw ? 'extracted' : 'site_absent',
                        applicationEnds_evidence: parsed.applicationEndsRaw
                            ? 'explicit Deadline/Apply by label OR derived from "N days remaining" badge'
                            : 'no explicit deadline and no "N days remaining" badge in card text',
                        salary: parsed.salary || null,
                        salary_status: parsed.salary ? 'extracted' : 'site_absent',
                        salary_evidence: parsed.salary
                            ? 'salary/compensation/NPR string in card text'
                            : 'no salary/compensation string in card text',
                        experience: parsed.experience || null,
                        level: parsed.level || null,
                        openings: parsed.openings || null
                    });
                } catch (err) {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }

            // Stop conditions for pagination.
            const noMoreByRange = harvested.range && harvested.range.to >= harvested.range.total;
            if (!harvested.nextUrl || cards.length === 0 || noMoreByRange) break;

            // Guard against loops.
            if (harvested.nextUrl === harvested.pageUrl) break;

            try {
                meta.pagesVisited++;
                await loadPage(page, harvested.nextUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 700 + 400);
            } catch (err) {
                console.warn(`?? [ekbana] failed to load page ${pageIndex + 1}: ${err.message}`);
                break;
            }

            pageIndex++;
        }

        if (items.length === 0) {
            console.log('  [ekbana] extracted 0 (no openings listed)');
            return { items, meta };
        }

        console.log(`  [ekbana] extracted ${items.length}`);
        return { items, meta };
    }
};