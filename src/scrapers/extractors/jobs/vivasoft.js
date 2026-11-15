// src/scrapers/extractors/jobs/vivasoft.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: the /career/ page IS the listing AND the item data --
// no per-job detail links exist (detailLinkCandidates is empty; anchors are
// site nav / case-study links). All vacancy cards live on this page as
// Elementor widgets. We therefore extract from the listing directly
// (single-page-cards), not via two-stage traversal.
//
// Selector drift history:
//   2026-11-15: job titles observed as
//       h3.elementor-heading-title.elementor-size-default  (e.g. "Senior
//       Executive, Cloud FinOps", "Vulnerability Management Analyst")
//     and as bare h2  (e.g. "Golang Intern", "AI/ML Intern").
//     Marketing H2s use elementor-image-box-title / elementor-icon-box-title
//     and are excluded by class. Do NOT use H1.elementor-cta__title -- that
//     is the hero banner ("Be a Part of Fastest The Growing Talented Team").

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://vivasoft.com.np/career/';
const COMPANY = 'Vivasoft Nepal';

const JOB_KEYWORDS =
    /intern|engineer|developer|analyst|executive|manager|designer|lead|senior|junior|specialist|consultant|architect|officer|coordinator|administrator|devops|qa\b/i;

function classifyEmploymentType(title) {
    if (!title) return null;
    const t = title.toLowerCase();
    if (t.includes('intern')) return 'internship';
    if (t.includes('trainee')) return 'internship';
    if (t.includes('contract')) return 'contract';
    if (t.includes('part-time') || t.includes('part time')) return 'part-time';
    if (t.includes('full-time') || t.includes('full time')) return 'full-time';
    return null;
}

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(Math.random() * 800 + 400);
        } catch (e) {
            console.warn(`[vivasoft] listing load failed: ${e.message}`);
            return { items: [], meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items: [], meta };
            }
        } catch (e) { /* best-effort */ }

        const cards = await page.evaluate(() => {
            const out = [];
            const seen = new Set();

            const grab = (headingEl) => {
                const title = (headingEl.textContent || '').trim();
                if (!title || title.length < 3 || title.length > 120) return null;
                if (seen.has(title)) return null;

                // Walk up to the nearest elementor widget; fall back to parent.
                const widget =
                    headingEl.closest('[class*="elementor-widget"]') ||
                    headingEl.parentElement;
                let description = null;
                let applyUrl = null;

                if (widget) {
                    let raw = (widget.innerText || widget.textContent || '').trim();
                    if (raw.startsWith(title)) raw = raw.slice(title.length).trim();
                    // Drop obvious CTA boilerplate tails.
                    raw = raw
                        .replace(/^(learn more|apply now|read more|view details)\s*$/i, '')
                        .trim();
                    if (raw.length >= 40) description = raw;

                    const a = widget.querySelector('a[href]');
                    if (a) {
                        const h = a.getAttribute('href') || '';
                        if (h && !/^#/.test(h) && !/vivasoft\.com\.np\/(about|blog|contact|#)/.test(h)) {
                            applyUrl = h;
                        }
                    }
                }

                seen.add(title);
                return { title, description, applyUrl };
            };

            // 1) Primary: h3.elementor-heading-title -- observed as job titles.
            const h3s = document.querySelectorAll('h3.elementor-heading-title');
            for (const h of h3s) {
                if (!JOB_KEYWORDS.test(h.textContent || '')) continue;
                const c = grab(h);
                if (c) out.push(c);
            }

            // 2) Secondary: bare h2 that look like role titles (exclude
            //    elementor-image-box / icon-box marketing headings).
            const h2s = document.querySelectorAll('h2');
            for (const h of h2s) {
                const cls = h.className || '';
                if (cls.includes('image-box') || cls.includes('icon-box')) continue;
                const text = (h.textContent || '').trim();
                if (!JOB_KEYWORDS.test(text)) continue;
                const c = grab(h);
                if (c) out.push(c);
            }

            return out;
        });

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        for (const card of cards) {
            try {
                if (!card.title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const employmentType = classifyEmploymentType(card.title);
                const description = card.description
                    ? cleanDescriptionText(card.description)
                    : null;

                const item = {
                    id: `vivasoft-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: card.title,
                    company: COMPANY,
                    companyUrl: 'https://vivasoft.com.np/',
                    url: LISTING_URL,
                    registrationUrl: card.applyUrl || null,
                    location: null,
                    description,
                    employmentType,
                    applicationEndsRaw: null,
                    salary: null,
                    image: null,
                    source: 'vivasoft'
                };

                if (!description) {
                    item.description_status = 'site_absent';
                    item.description_evidence =
                        'careers page renders role cards as short Elementor widgets ' +
                        'without a per-role body block; closest elementor-widget text ' +
                        'under 40 chars after stripping the title';
                }
                if (!employmentType) {
                    item.employmentType_status = 'site_absent';
                    item.employmentType_evidence =
                        'title "' + card.title + '" carries no intern/part-time/' +
                        'full-time/contract token; page has no employment-type label';
                }
                if (!card.applyUrl) {
                    item.registrationUrl_status = 'site_absent';
                    item.registrationUrl_evidence =
                        'widget had no non-nav a[href]; page routes applications ' +
                        'through the on-page contact form (no per-job apply URL)';
                }
                item.location_status = 'site_absent';
                item.location_evidence =
                    'no [class*="location"] element contains a job-specific city; ' +
                    'only header/footer chrome matches';
                item.applicationEndsRaw_status = 'site_absent';
                item.applicationEndsRaw_evidence =
                    'no "Apply before"/"Deadline"/"Closing" text on any career card';
                item.salary_status = 'site_absent';
                item.salary_evidence =
                    'no salary/compensation element in career cards';
                item.image_status = 'site_absent';
                item.image_evidence =
                    'career cards are text-only; hero images are page-level banners';

                items.push(item);
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [vivasoft] extracted ${items.length}`);
        return { items, meta };
    }
};