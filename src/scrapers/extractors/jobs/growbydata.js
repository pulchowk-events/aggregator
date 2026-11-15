// src/scrapers/extractors/jobs/growbydata.js
// Site: https://growbydata.com/career-overview/
// Verdict: CAREERS_PAGE.
//
// Corrections to the wizard's assumptions:
//   - Site type is SINGLE-PAGE-CARDS (accordion list), NOT listing-to-detail.
//     The detected "/ (12 matches)" pattern was FALSE POSITIVE (nav chrome).
//     detailLinkCandidates are all /solutions/. marketing pages - not jobs.
//   - The "sample detail page" in the dump is /solutions/search-intelligence/
//     - completely unrelated to careers. So `H1.display-4` and
//     `div.cky-accordion` are NOT the job title / body selectors.
//   - Real job structure (from cardGroups + bodySnippet + cardCandidates):
//       <div class="accordion-group career-box">
//         <div class="accordion-heading">
//           <h3>
//             <a href="#collapse-N" class="accordion-toggle" data-toggle="collapse">
//               <span class="gbd-careers-title">SEO ANALYST</span>
//               ...
//             </a>
//           </h3>
//         </div>
//         <div id="collapse-N" class="collapse"> ... body ... </div>
//       </div>
//     Confirmed: 10 accordion-group.career-box instances, jobTitleRatio 1.0,
//     titles like "SEO ANALYST" and "SENIOR SOFTWARE ENGINEER - DATA PLATFORM".
//   - There is NO per-job URL. The accordion anchor href is `#collapse-N`.
//     Application happens via email/contact form referenced inside the body.
//   - Company = "GrowByData" (og:site_name). Locations published
//     site-wide: "Boston US, Kathmandu Nepal, and Remote" (per og:title).
//
// Traversal: single page. Expand all accordions, harvest each block.
//
// Selector drift history:
//   2026-11-15: initial extraction. Anchored on div.accordion-group.career-box
//                + span.gbd-careers-title. Body is the sibling #collapse-N
//                (Bootstrap collapse, content present in DOM when collapsed,
//                but we click toggles defensively).

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const GBD_URL = 'https://growbydata.com/career-overview/';
const GBD_COMPANY = 'GrowByData';

function parseBodyText(text) {
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

    const deadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    if (deadline) out.applicationEndsRaw = deadline[1].trim();

    const salary = text.match(/(?:Salary|Compensation|NPR|USD|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    // Per-role location if body specifies it (falls back to site-wide otherwise).
    const location = text.match(/(?:Location|Based in|Office)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (location) out.location = location[1].trim();

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load ----
        try {
            meta.pagesVisited++;
            await loadPage(page, GBD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 700 + 400);
        } catch (err) {
            console.warn(`?? [growbydata] failed to load careers page: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [growbydata] page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('div.accordion-group.career-box, span.gbd-careers-title', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // Expand every accordion - best-effort.
        try {
            await page.evaluate(() => {
                document.querySelectorAll(
                    '.career-box .accordion-toggle, .career-box a[data-toggle="collapse"]'
                ).forEach((el) => {
                    try { el.click(); } catch (_) { /* ignore */ }
                });
            });
            await delay(600);
        } catch (e) { /* ignore */ }

        // ---- Harvest ----
        const harvested = await page.evaluate(() => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            const blocks = Array.from(document.querySelectorAll('div.accordion-group.career-box'));
            const out = [];
            const seen = new Set();

            for (const block of blocks) {
                if (block.closest('header, footer, nav')) continue;

                // Title
                const titleEl = block.querySelector('span.gbd-careers-title')
                    || block.querySelector('.accordion-heading h3, .accordion-heading a');
                let title = clean(titleEl ? titleEl.textContent : null);
                if (!title || title.length < 2 || title.length > 200) continue;
                // Normalise the en-dash / em-dash used in some titles.
                title = title.replace(/\s*[--]\s*/g, ' - ');

                // Body - collapse sibling / descendant whose id starts with
                // "collapse". Bootstrap keeps the content in DOM either way.
                const toggle = block.querySelector('.accordion-toggle');
                let bodyEl = null;
                if (toggle) {
                    const href = toggle.getAttribute('href') || '';
                    const m = href.match(/^#(.+)$/);
                    if (m) bodyEl = document.getElementById(m[1]);
                }
                if (!bodyEl) bodyEl = block.querySelector('[id^="collapse"], .collapse, .accordion-body');
                if (!bodyEl) {
                    // Last resort: the block minus the heading.
                    bodyEl = block;
                }

                let description = clean(bodyEl ? bodyEl.innerText : null);
                // Strip the title from the body if we fell back to the whole block.
                if (description && title && description.startsWith(title)) {
                    description = description.slice(title.length).trim();
                }
                if (!description || description.length < 20) description = null;

                // Apply link - mailto:career* / mailto:hr* / form submit within block.
                let applyUrl = null;
                const applyA = Array.from(block.querySelectorAll('a[href]')).find((a) => {
                    const href = a.getAttribute('href') || '';
                    if (!href) return false;
                    if (href.startsWith('#collapse')) return false;
                    if (a === toggle) return false;
                    const t = (a.textContent || '').trim().toLowerCase();
                    if (href.startsWith('mailto:')) {
                        return /career|jobs?|hr@|resume|apply/i.test(href) || /apply|email/i.test(t);
                    }
                    return /apply|submit|careers?@/.test(t);
                });
                if (applyA) {
                    try { applyUrl = applyA.href; } catch (_) { /* ignore */ }
                }

                const img = block.querySelector('img');
                let image = null;
                if (img) {
                    try { image = window.__resolveImageSrc(img); } catch (_) { /* ignore */ }
                }

                const key = title;
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({ title, description, applyUrl, image });
            }

            // Site-wide location hint from the OG/body copy.
            let siteLocation = null;
            try {
                const m = (document.title + ' ' + (document.body.innerText || ''))
                    .match(/\b(Boston|Kathmandu|Nepal|Remote|United States|USA)\b/i);
                if (m) siteLocation = m[1];
            } catch (_) { /* ignore */ }

            return { cards: out, siteLocation };
        });

        const cards = harvested.cards || [];
        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            console.log('  [growbydata] extracted 0 (no open positions)');
            return { items, meta };
        }

        // ---- Build items ----
        for (const card of cards) {
            try {
                const parsed = parseBodyText(card.description || '');

                // Location: per-role if it says so; else site-wide "Boston US,
                // Kathmandu Nepal, and Remote" (from og:title).
                let location = parsed.location || null;
                if (!location && card.description) {
                    const city = card.description.match(/\b(Kathmandu|Boston|Nepal|Remote|United States|USA)\b/i);
                    if (city) location = city[1];
                }
                if (!location) {
                    // Site-wide: Boston US / Kathmandu Nepal / Remote.
                    location = harvested.siteLocation
                        ? `${harvested.siteLocation} (site-wide: Boston US, Kathmandu Nepal, Remote)`
                        : 'Boston US / Kathmandu Nepal / Remote';
                }

                items.push({
                    id: `growbydata-${(card.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                    title: card.title,
                    company: GBD_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name "GrowByData" and site chrome',
                    description: card.description || null,
                    description_status: card.description ? 'extracted' : 'extraction_failed',
                    description_evidence: card.description
                        ? 'accordion body of div.accordion-group.career-box (sibling #collapse-N, Bootstrap content present in DOM)'
                        : 'accordion body under div.accordion-group.career-box produced no text after expanding toggles',
                    date: null,
                    time: null,
                    location,
                    location_status: 'extracted',
                    location_evidence: parsed.location
                        ? 'Location/Office label in accordion body'
                        : 'site-wide og:title "Careers at GrowByData - Boston US, Kathmandu Nepal, and Remote"',
                    price: null,
                    organizer: GBD_COMPANY,
                    category: null,
                    tags: [parsed.employmentType, parsed.level, parsed.attendanceMode].filter(Boolean),
                    image: card.image || null,
                    image_status: card.image ? 'extracted' : 'site_absent',
                    image_evidence: card.image
                        ? 'first img inside div.accordion-group.career-box'
                        : 'no img inside the accordion block',
                    url: card.applyUrl || GBD_URL,
                    registrationUrl: card.applyUrl || GBD_URL,
                    attendanceMode: parsed.attendanceMode
                        || (location && /remote/i.test(location) ? 'remote' : 'in-person'),
                    source: 'growbydata',
                    employmentType: parsed.employmentType || null,
                    employmentType_status: parsed.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: parsed.employmentType
                        ? 'Full/Part/Contract/Internship token in accordion body'
                        : 'no employment-type token in accordion body',
                    applicationEndsRaw: parsed.applicationEndsRaw || null,
                    applicationEnds_status: parsed.applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: parsed.applicationEndsRaw
                        ? 'Deadline/Apply by label in accordion body'
                        : 'no Deadline/Apply by label in accordion body',
                    salary: parsed.salary || null,
                    salary_status: parsed.salary ? 'extracted' : 'site_absent',
                    salary_evidence: parsed.salary
                        ? 'salary/compensation/NPR/USD string in accordion body'
                        : 'no salary/compensation string in accordion body',
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

        console.log(`  [growbydata] extracted ${items.length}`);
        return { items, meta };
    }
};