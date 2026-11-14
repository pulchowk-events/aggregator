// src/scrapers/extractors/jobs/nimble.js
// Site-specific extractor for career.nimble.com.np.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/recruitment/public/index` (4 matches) is
//     the site's own LISTING route used as a nav link ("Job List", "Home",
//     logo). It is NOT a per-job detail URL - detailLinkCandidates is
//     essentially the index page itself.
//   - The "card wrapper" `meta` (17) is HTML metadata.
//   - cardCandidates include a div.row that contains the literal body text
//     "No any vacancy available at the moment, please keep in touch for
//     future vacancies" - confirming the LISTING IS CURRENTLY EMPTY.
//   - No JSON-LD anywhere, no per-job hrefs, no role headings.
//   - The page IS the careers listing (title "Nimble Infosys Pvt. Ltd. -
//     Job Opening List"; nav has "Job List"; instruction to apply block;
//     a banner image "GetDocument?token=...").
//
// Strategy: defensive and safe -
//   1) On load, detect the "No any vacancy available at the moment"
//      banner and short-circuit with an empty list (avoids scraping
//      footer/nav as roles).
//   2) If vacancy cards DO exist later (site changes), extract via
//      JSON-LD JobPosting, then via /recruitment/public/job-detail-style
//      hrefs, then via role headings inside a "Job List"/"Current
//      Vacancies" block. Any registration URL pointing at a
//      /recruitment/Public/GetDocument?token=... is a document download
//      (job description PDF) and is kept as registrationUrl only, not
//      as the canonical item url.
//   3) Return [] gracefully when nothing real is found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const NIMBLE_CAREERS_URL = 'https://career.nimble.com.np/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [nimble] Scraping Nimble Infosys job list...');

        meta.pagesVisited++;
        await page.goto(NIMBLE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [nimble] page looks blocked/captcha - bailing out');
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
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            const bodyTxt = (document.body && document.body.innerText) || '';

            // ---- 0) Explicit "no vacancies" short-circuit ----
            // Evidence: body contains "No any vacancy available at the
            // moment, please keep in touch for future vacancies".
            const emptyBanner =
                /no (any )?vacanc(?:y|ies) available/i.test(bodyTxt) ||
                /please keep in touch for future vacanc/i.test(bodyTxt);
            const hasJsonLdJobs = (() => {
                for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                    const txt = s.textContent || '';
                    if (/"@type"\s*:\s*"JobPosting"/i.test(txt)) return true;
                }
                return false;
            })();
            // Job-listing specific markers. Only count real job indicators,
            // NOT the nav "Job List" label alone (which is always present).
            const hasRealJobMarkers =
                /(position\s*:?\s*\S|apply\s+for|deadline|job\s+title|no\.?\s*of\s+vacanc|required\s+qualification|number\s+of\s+vacanc)/i
                    .test(bodyTxt);

            if (emptyBanner && !hasJsonLdJobs && !hasRealJobMarkers) {
                return out;
            }

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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Nimble Infosys Pvt. Ltd.';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `nimble-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Nimble Infosys Pvt. Ltd.',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'nimble',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // On this site, per-job detail pages (when they exist) look like
            // /recruitment/public/jobDetail/<id>, /recruitment/public/view/<id>,
            // or /recruitment/Public/GetDocument?token=... (a PDF handout).
            // We accept those as registrationUrl; the canonical item url stays
            // the listing page (index) unless a clear detail route is present.
            const jobHrefRe = /\/recruitment\/(public\/)?(job|jobs|job-detail|jobDetail|view|apply|position|vacanc)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (!raw) continue;
                if (/^(tel:|mailto:|javascript:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
                // Skip login/register links - those are auth, not jobs.
                if (/\/recruitment\/public\/(login|register)/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;

                const isDocDownload = /\/recruitment\/Public\/GetDocument\?token=/i.test(href);
                if (!isDocDownload && !jobHrefRe.test(href)) continue;

                const title = clean(a.textContent);
                // Skip nav labels and generic controls.
                if (!title) continue;
                if (title.length < 3 || title.length > 160) continue;
                if (/^(home|job list|about|login|register|facebook|twitter|apply|read more|view details?)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                // For document-download "apply" links, use the listing URL
                // as canonical; for real job-detail routes, use the link.
                const canonical = isDocDownload ? entryUrl : href;

                out.push({
                    id: `nimble-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Nimble Infosys Pvt. Ltd.',
                    category: null,
                    tags: [],
                    image: null,
                    url: canonical,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'nimble',
                });
            }

            // ---- 3) Role headings inside a "Job List"/"Current Vacancies" block ----
            const openingsHeadingRe = /(job list|current vacanc(?:y|ies)|open positions?|open roles?|current openings?|we['']?re hiring|job openings?|all jobs)/i;
            const marketingHeadingRe = /^(its our mission|no any vacancy available|please keep in touch|instruction to apply|contact|navigations|home|about|login|register|job list)/i;

            // Exclude the nav / footer / contact block wrappers.
            const isNonJobCard = (el) => {
                if (!el) return false;
                if (el.closest('footer, .footer, .nav, nav, header')) return true;
                if (el.closest('.nim-footer-indv')) return true;
                return false;
            };

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
                if (h.closest('nav, header, footer')) continue;
                if (isNonJobCard(h)) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 5 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, li, article, .job, .job-card, .vacancy, .position').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .vacancy-title, .position-title, .opening-title'
                )) {
                    if (el.closest('nav, header, footer')) continue;
                    if (isNonJobCard(el)) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const card = el.closest('li, article, div') || el.parentElement;
                    if (!card) continue;

                    const ctrl = Array.from(card.querySelectorAll('a, button'))
                        .find((c) => /^apply( now)?$|view (role|job|details?)|read more/i
                            .test((c.textContent || '').trim()));

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
                                if (!/\/recruitment\/Public\/GetDocument\?token=/i.test(resolved)) url = resolved;
                            }
                        }
                    }

                    out.push({
                        id: `nimble-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Nimble Infosys Pvt. Ltd.',
                        category: null,
                        tags: [],
                        image: null,
                        url,
                        registrationUrl: registrationUrl || url,
                        attendanceMode: null,
                        source: 'nimble',
                    });
                }
            }

            return out;
        }, NIMBLE_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[nimble] no vacancies currently listed ("No any vacancy available at the moment") - returning empty list');
        } else {
            console.log(`? [nimble] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};