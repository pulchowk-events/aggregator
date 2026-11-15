// src/scrapers/extractors/jobs/esignature.js
// Site: https://esignature.com.np/careers
// Verdict: CAREERS_PAGE.
//
// Corrections to the wizard's assumptions:
//   - Site type is SINGLE-PAGE-CARDS (accordion list), not listing-to-detail.
//     The detected "/ (7 matches)" pattern was FALSE POSITIVE - those are nav
//     links. detailLinkCandidates were all nav URLs.
//   - "Detail title H2._9vd5" came from a WhatsApp-redirect sample page - the
//     wizard's detail-page evidence is entirely spurious.
//   - Real job structure (from cardGroups.openP sample):
//       <div class="openP">
//         <div class="c-open__list-title">
//           <p class="subt1">Digital Content Writer - 04</p>
//           ... accordion toggle ...
//         </div>
//         <div id="collapseone" class="collapse">
//           ... job description ...
//         </div>
//       </div>
//     12 such blocks confirmed (12 openP instances).
//   - Every job's Apply CTA points at the same URL: /career/job-apply.
//     There are no per-job detail URLs; the application form is shared.
//   - "DETAILED JOB DESCRIPTION / REQUIREMENTS:" and "Roles and
//     Responsibilities:" h2s live inside the accordion bodies - the role
//     body IS in the DOM (even when collapsed, since Bootstrap keeps the
//     content mounted), so we can read it without expanding.
//
// Traversal: one page, one page.evaluate. Expand accordions defensively
// before reading so we never miss lazily-mounted bodies.
//
// Selector drift history:
//   2026-11-15: initial extraction. Anchored on div.openP + p.subt1 (title)
//                and the sibling .collapse body for description.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ESIG_LISTING = 'https://esignature.com.np/careers';
const ESIG_APPLY = 'https://esignature.com.np/career/job-apply';
const ESIG_COMPANY = 'E-Signature Pvt. Ltd.';

function parseTitle(rawTitle) {
    // Titles look like "Digital Content Writer - 04" or "SEO Executive - 02".
    // The trailing number is a position count / ID, not part of the role name.
    if (!rawTitle) return { title: null, openings: null };
    const m = rawTitle.match(/^(.*?)\s*[--]\s*(\d{1,3})\s*$/);
    if (m) return { title: m[1].trim(), openings: m[2] };
    return { title: rawTitle.trim(), openings: null };
}

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

    const deadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    if (deadline) out.applicationEndsRaw = deadline[1].trim();

    const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    const location = text.match(/(?:Location|Based in|Office)\s*[:\-]?\s*([^\n|]{2,60})/i)
        || text.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote)\b/i);
    if (location) out.location = location[1];

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load ----
        try {
            meta.pagesVisited++;
            await loadPage(page, ESIG_LISTING, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 700 + 400);
        } catch (err) {
            console.warn(`?? [esignature] failed to load careers page: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [esignature] page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('div.openP, p.subt1, .c-open__list-title', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // Expand every accordion so any lazy-mounted bodies are present.
        // Best-effort: ignore failures.
        try {
            await page.evaluate(() => {
                const toggles = document.querySelectorAll(
                    '[data-toggle="collapse"], .c-open__list-title, .accordion-button-icon'
                );
                for (const t of toggles) {
                    try { t.click(); } catch (_) { /* ignore */ }
                }
            });
            await delay(600);
        } catch (e) { /* ignore */ }

        // ---- Harvest cards ----
        const harvested = await page.evaluate((applyUrl) => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            const blocks = Array.from(document.querySelectorAll('div.openP'));
            const out = [];
            const seen = new Set();

            for (const block of blocks) {
                if (block.closest('header, footer, nav')) continue;

                // Title
                const titleEl = block.querySelector('p.subt1, .c-open__list-title p, .c-open__list-title');
                const rawTitle = clean(titleEl ? titleEl.textContent : null);
                if (!rawTitle || rawTitle.length < 3 || rawTitle.length > 160) continue;

                // Body - collapse sibling, or any descendant whose id starts
                // with "collapse".
                let bodyEl = null;
                const titleWrap = block.querySelector('.c-open__list-title');
                if (titleWrap && titleWrap.nextElementSibling) {
                    bodyEl = titleWrap.nextElementSibling;
                }
                if (!bodyEl) {
                    bodyEl = block.querySelector('[id^="collapse"], .collapse, .accordion-body');
                }

                const bodyText = clean(bodyEl ? bodyEl.innerText : null)
                    || clean(block.innerText); // last resort - includes title

                // Strip the title prefix from body text if we fell back.
                let description = bodyText || null;
                if (description && description.startsWith(rawTitle)) {
                    description = description.slice(rawTitle.length).trim();
                }

                // Skip empty bodies.
                if (!description || description.length < 20) description = null;

                const key = rawTitle;
                if (seen.has(key)) continue;
                seen.add(key);

                // Image - first img inside block, if any (often none).
                const img = block.querySelector('img');
                let image = null;
                if (img) {
                    try { image = window.__resolveImageSrc(img); } catch (_) { /* ignore */ }
                }

                out.push({
                    rawTitle,
                    description,
                    image,
                    applyUrl
                });
            }

            // Site-wide location hint (about-us copy mentions Kathmandu).
            let siteLocation = null;
            try {
                const m = (document.body.innerText || '').match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal)\b/i);
                if (m) siteLocation = m[1];
            } catch (_) { /* ignore */ }

            return { cards: out, siteLocation };
        }, ESIG_APPLY);

        const cards = harvested.cards || [];
        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            console.log('  [esignature] extracted 0 (no open positions listed)');
            return { items, meta };
        }

        // ---- Build items ----
        for (const card of cards) {
            try {
                const { title, openings } = parseTitle(card.rawTitle);
                if (!title) { meta.detailParseFailures++; safeUnitDone(progress); continue; }

                const parsed = parseBodyText(card.description || '');
                const location = parsed.location || harvested.siteLocation || null;

                items.push({
                    id: `esignature-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                    title,
                    company: ESIG_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'page footer / about copy names E-Signature Pvt. Ltd.',
                    description: card.description || null,
                    description_status: card.description ? 'extracted' : 'extraction_failed',
                    description_evidence: card.description
                        ? 'accordion body text inside div.openP (Bootstrap collapse, content present in DOM even when collapsed)'
                        : 'accordion body under div.openP was empty after expanding - no role body found',
                    date: null,
                    time: null,
                    location: location || null,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: parsed.location
                        ? 'Location/Based in label or city token in accordion body'
                        : (harvested.siteLocation
                            ? 'site-wide Nepal/Kathmandu token in page copy (no per-job location published)'
                            : 'no location label in body and no city token on page'),
                    price: null,
                    organizer: ESIG_COMPANY,
                    category: null,
                    tags: [parsed.employmentType, parsed.level, parsed.attendanceMode].filter(Boolean),
                    image: card.image || null,
                    image_status: card.image ? 'extracted' : 'site_absent',
                    image_evidence: card.image
                        ? 'first img inside div.openP block'
                        : 'no img inside div.openP block',
                    url: card.applyUrl || ESIG_LISTING,
                    registrationUrl: card.applyUrl || ESIG_LISTING,
                    attendanceMode: parsed.attendanceMode || null,
                    source: 'esignature',
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
                        ? 'salary/compensation/NPR string in accordion body'
                        : 'no salary/compensation string in accordion body',
                    experience: parsed.experience || null,
                    level: parsed.level || null,
                    openings: openings || null
                });
            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [esignature] extracted ${items.length}`);
        return { items, meta };
    }
};