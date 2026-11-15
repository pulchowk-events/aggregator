// src/scrapers/extractors/jobs/eminenceways.js
// Site: https://eminenceways.com/career
// Verdict: CAREERS_PAGE.
//
// Corrections to the wizard's assumptions:
//   - Site type is SINGLE-PAGE-CARDS, not listing-to-detail. The detected
//     "/home (3 matches)" pattern is FALSE POSITIVE - those are nav links
//     to the marketing homepage. detailLinkCandidates was empty.
//   - "Card wrapper: meta" is chrome; "H1.homepage-three-title" belongs to
//     the *home* page sample, not the careers page.
//   - Real signal on the careers page (from bodySnippet + fieldEvidence):
//       "CAREER" (h2) is the section heading, and each opening is an h2:
//         "Business Development Associate"
//       "Our Location . Kathmandu" appears in footer widget.
//     No per-job URL - applications happen on-page (likely a contact form
//     or mailto). We return the careers page URL for url/registrationUrl.
//
// Traversal: one page, one page.evaluate. Empty openings  [] cleanly.
//
// Selector drift history:
//   2026-11-15: initial extraction. Anchor on the "CAREER" h2 and treat
//                subsequent h2/h3s in the same section as job titles.
//                Exclude obvious chrome (Our Location, Pages, etc.).

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EMINENCE_URL = 'https://eminenceways.com/career';
const EMINENCE_COMPANY = 'Eminence Ways Pvt. Ltd.';

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

    const deadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    if (deadline) out.applicationEndsRaw = deadline[1].trim();

    const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load ----
        try {
            meta.pagesVisited++;
            await loadPage(page, EMINENCE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 700 + 400);
        } catch (err) {
            console.warn(`?? [eminenceways] failed to load careers page: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [eminenceways] page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('h1, h2, body', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // ---- Harvest ----
        const harvested = await page.evaluate(() => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            // Section root: the "CAREER" h2's closest wrapping <section>/<div>.
            const careerH = Array.from(document.querySelectorAll('h1, h2, h3'))
                .find((el) => /^careers?$/i.test((el.textContent || '').trim()));

            let root = null;
            if (careerH) {
                let p = careerH.parentElement;
                for (let i = 0; i < 6 && p; i++) {
                    // Section should contain more than just the heading.
                    const txt = clean(p.innerText) || '';
                    if (txt.length > 80 && p.querySelector('h1, h2, h3, h4, a[href], button')) {
                        root = p;
                        break;
                    }
                    p = p.parentElement;
                }
            }
            if (!root) {
                // Fallback: main content area.
                root = document.querySelector('main, [class*="career"], #content') || document.body;
            }

            // Chrome / non-job titles that must not be treated as jobs.
            const CHROME_TITLE = /^(career|careers|home|home\s*career|join our team!?|our location|pages|quick links|about us|services|projects|blog|gallery|contact us|contact|follow us|newsletter|subscribe)$/i;

            const hEls = Array.from(root.querySelectorAll('h2, h3, h4'));
            const out = [];
            const seen = new Set();

            for (const h of hEls) {
                const title = clean(h.textContent);
                if (!title || title.length < 3 || title.length > 120) continue;
                if (CHROME_TITLE.test(title)) continue;
                if (/^our\s+/i.test(title)) continue;      // "Our Location", "Our Services"
                if (/^business development associate$/i.test(title) === false
                    && /^(career|join|follow|contact|connect|stay)/i.test(title)) continue;

                // Pick the smallest ancestor block that contains this heading
                // plus at least one of: paragraph, list, button, mailto, link.
                let block = h.parentElement;
                let chosen = null;
                for (let i = 0; i < 5 && block; i++) {
                    if (block.closest('header, footer, nav')) break;
                    const hasBody = block.querySelector('p, ul, ol, a[href], button');
                    if (hasBody) { chosen = block; break; }
                    block = block.parentElement;
                }
                if (!chosen) chosen = h.parentElement;

                const text = clean(chosen.innerText) || '';
                if (!text) continue;

                // Apply CTA - mailto or apply link.
                let applyHref = null;
                const applyA = Array.from(chosen.querySelectorAll('a[href]')).find((a) => {
                    const href = a.getAttribute('href') || '';
                    const t = (a.textContent || '').toLowerCase();
                    if (href.startsWith('mailto:')) return true;
                    if (href.startsWith('tel:')) return false;
                    if (a.closest('header, footer, nav')) return false;
                    return /apply|send (?:your )?(?:cv|resume)|careers?@/i.test(t);
                });
                if (applyA) {
                    try { applyHref = applyA.href; } catch (_) { /* ignore */ }
                }

                // Description candidate: longest paragraph/list text inside block.
                let description = null;
                const paras = Array.from(chosen.querySelectorAll('p, li'))
                    .map((p) => clean(p.textContent) || '')
                    .filter((s) => s.length >= 40 && s.length <= 1500)
                    .sort((a, b) => b.length - a.length);
                if (paras[0]) description = paras[0];

                const img = chosen.querySelector('img');
                let image = null;
                if (img) {
                    try { image = window.__resolveImageSrc(img); } catch (_) { /* ignore */ }
                }

                const key = title;
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({ title, text, applyHref, description, image });
            }

            // Fallback: if no heading-based jobs found, scan for mailto
            // careers links with adjacent text (still no per-job URLs).
            if (out.length === 0) {
                const mailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
                    .filter((a) => !a.closest('header, footer, nav'));
                for (const a of mailLinks) {
                    const block = a.closest('section, article, div');
                    if (!block) continue;
                    const text = clean(block.innerText) || '';
                    if (!text || text.length < 20) continue;
                    const h = block.querySelector('h1, h2, h3, h4');
                    const title = clean(h ? h.textContent : null);
                    if (!title || CHROME_TITLE.test(title)) continue;
                    if (out.find((o) => o.title === title)) continue;
                    out.push({ title, text, applyHref: a.href, description: null, image: null });
                }
            }

            // Site location / phone from footer widgets.
            let siteLocation = null;
            try {
                const addrEl = document.querySelector('address, [class*="location"], [class*="address"]');
                if (addrEl) {
                    const t = clean(addrEl.textContent);
                    if (t) {
                        const m = t.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal)\b/i);
                        siteLocation = m ? m[1] : t.slice(0, 80);
                    }
                }
                if (!siteLocation) {
                    const m = (document.body.innerText || '').match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal)\b/i);
                    if (m) siteLocation = m[1];
                }
            } catch (_) { /* ignore */ }

            return { cards: out, siteLocation };
        });

        const cards = harvested.cards || [];
        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            console.log('  [eminenceways] extracted 0 (no current openings)');
            return { items, meta };
        }

        for (const card of cards) {
            try {
                const parsed = parseCardText(card.text || '');
                const locMatch = (card.text || '').match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote)\b/i);
                const location = locMatch ? locMatch[1] : (harvested.siteLocation || null);

                items.push({
                    id: `eminenceways-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: card.title,
                    company: EMINENCE_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'footer copyright "c2026 Eminence Ways Pvt. Ltd."',
                    description: card.description || null,
                    description_status: card.description ? 'extracted' : 'site_absent',
                    description_evidence: card.description
                        ? 'longest paragraph/list item inside the job block'
                        : 'no paragraph or list item >=40 chars inside the job block; site does not publish a role body inline and there is no per-job detail page',
                    date: null,
                    time: null,
                    location: location || null,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: locMatch
                        ? 'city/region token inside the job block'
                        : (harvested.siteLocation
                            ? 'site address block ([class*="location"] / body text)'
                            : 'no location token in the job block and no address element on page'),
                    price: null,
                    organizer: EMINENCE_COMPANY,
                    category: null,
                    tags: [parsed.employmentType, parsed.level, parsed.attendanceMode].filter(Boolean),
                    image: card.image || null,
                    image_status: card.image ? 'extracted' : 'site_absent',
                    image_evidence: card.image
                        ? 'first img inside the job block'
                        : 'no img inside the job block',
                    url: card.applyHref || EMINENCE_URL,
                    registrationUrl: card.applyHref || EMINENCE_URL,
                    attendanceMode: parsed.attendanceMode || null,
                    source: 'eminenceways',
                    employmentType: parsed.employmentType || null,
                    employmentType_status: parsed.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: parsed.employmentType
                        ? 'Full/Part/Contract/Internship token in job block text'
                        : 'no employment-type token in job block text',
                    applicationEndsRaw: parsed.applicationEndsRaw || null,
                    applicationEnds_status: parsed.applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: parsed.applicationEndsRaw
                        ? 'Deadline/Apply by label in job block text'
                        : 'no Deadline/Apply by label in job block text',
                    salary: parsed.salary || null,
                    salary_status: parsed.salary ? 'extracted' : 'site_absent',
                    salary_evidence: parsed.salary
                        ? 'salary/compensation/NPR string in job block text'
                        : 'no salary/compensation string in job block text',
                    experience: parsed.experience || null,
                    level: parsed.level || null
                });
            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [eminenceways] extracted ${items.length}`);
        return { items, meta };
    }
};