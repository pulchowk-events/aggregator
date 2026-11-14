// src/scrapers/extractors/jobs/agile.js
// Site-specific extractor for agile.com.np careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `%C2%A0014004789` (10 matches) is a
//     tel: phone number link, NOT a job detail link. That assumption
//     was wrong; there are no real job-detail hrefs in the dump.
//   - The "card wrapper" `link` (38 instances) is the HTML <link> tag -
//     metadata, not cards. Also wrong.
//   - The page IS the careers page (title "Careers at Agile Solutions -
//     Grow with Us"; body mentions "Build Your Future with Nepal's
//     Leading Microsoft Solutions Partner"). Proceed.
//   - No JSON-LD JobPosting present (only WebPage / BreadcrumbList /
//     WebSite / Organization). The actual job cards, if any, live in
//     the Elementor body but were not captured by the dump. So we
//     extract defensively: JSON-LD first, then href-pattern anchors,
//     then heading-based cards. Return empty gracefully otherwise.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const AGILE_CAREERS_URL = 'https://agile.com.np/career/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [agile] Scraping Agile Solutions careers...');

        meta.pagesVisited++;
        await page.goto(AGILE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // let Elementor widgets settle

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [agile] page looks blocked/captcha - bailing out');
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

            // ---- 1) JSON-LD JobPosting (preferred when present) ----
            const ldScripts = Array.from(
                document.querySelectorAll('script[type="application/ld+json"]')
            );
            for (const s of ldScripts) {
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
                    const url = node.url ? abs(node.url) : window.location.href;
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Agile Solutions';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `agile-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Agile Solutions',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || window.location.href,
                        registrationUrl: url || window.location.href,
                        attendanceMode,
                        source: 'agile',
                    });
                }
            }

            // ---- 2) Anchor heuristic for real job-detail links ----
            // Only hrefs that clearly look like a job detail (NOT the /career/
            // listing itself, NOT tel:/mailto:, NOT nav/footer service links).
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const navServiceRe = /\/(services?|solutions?|industr(?:y|ies)|about|blog)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');
            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (navServiceRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `agile-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Agile Solutions',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'agile',
                });
            }

            // ---- 3) Heading-based job cards (Elementor sectioned layout) ----
            // Fallback: if a heading (h3/h4) sits inside a block that also
            // contains an "Apply"/"View"/"Details" control, treat the heading
            // as a job title. Very conservative - skips section headings
            // that look like marketing copy.
            const marketingHeadingRe = /(build|future|leading|partner|welcome|join|benefit|why |our |about)/i;
            for (const h of document.querySelectorAll('h3, h4')) {
                if (h.closest('nav, header, footer')) continue;
                const title = clean(h.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (marketingHeadingRe.test(title)) continue;

                const card = h.closest('article, section, div') || h.parentElement;
                if (!card) continue;
                const hasApply = Array.from(card.querySelectorAll('a, button'))
                    .some((el) => /apply|view|details?|read more/i.test(el.textContent || ''));
                if (!hasApply) continue;

                const key = (title + '|' + window.location.href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                const applyLink = Array.from(card.querySelectorAll('a[href]'))
                    .find((el) => /apply|view|details?|read more/i.test(el.textContent || ''));
                const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                out.push({
                    id: `agile-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Agile Solutions',
                    category: null,
                    tags: [],
                    image: null,
                    url: applyHref || window.location.href,
                    registrationUrl: applyHref || window.location.href,
                    attendanceMode: null,
                    source: 'agile',
                });
            }

            return out;
        }, AGILE_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[agile] no scrapeable job cards found - returning empty list');
        } else {
            console.log(`? [agile] extracted ${items.length} job(s)`);
        }

        return { items, meta };
    },
};