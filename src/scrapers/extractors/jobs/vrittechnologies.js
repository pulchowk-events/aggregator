// src/scrapers/extractors/jobs/vrittechnologies.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape (corrected from evidence):
//   - Entry /jobs is a Next.js job listing grouped by department
//     ("Creative Department", "SEO Department", ...), each with job cards.
//   - The detected "/vrittech/" detail-link pattern was a FALSE POSITIVE -
//     those are x.com / instagram / facebook social links, not job posts.
//   - Real job detail links are `a[href^="/jobs/"]` (e.g. /jobs/seo-intern),
//     confirmed in the /career dump. Job cards expose title, department,
//     "Experience Level: <x>", "Vacancy: <n>" and a "View Details" anchor.
//   - We intentionally do NOT navigate detail pages: the only detail-page
//     dump available was x.com (wrong page), so any detail selector would be
//     invented. We harvest everything from the listing card instead and set
//     url/registrationUrl to the real detail href for follow-up.
//
// Selector drift history:
//   2026-11-14: initial. Title comes from heading inside the card; falls back
//               to the text node preceding "Experience Level:".
//   2026-11-14: listing anchor pattern is /jobs/<slug>, NOT /vrittech/.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const VRIT_JOBS_URL = 'https://www.vrittechnologies.com/jobs';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        await page.goto(VRIT_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(Math.random() * 1000 + 500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [vrittechnologies] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) {
            // best-effort diagnostics
        }

        // The listing is client-rendered; wait for a job-ish marker.
        try {
            await page.waitForFunction(
                () => /Experience Level|Vacancy|View Details/i.test(document.body.innerText || ''),
                { timeout: 15000 }
            );
        } catch (e) {
            console.log('?? [vrittechnologies] No job markers appeared; extracting what is present.');
        }

        // Let any late-hydrating cards mount.
        await delay(500);

        const jobs = await page.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

            const expRe = /Experience Level\s*:\s*([^\n]+?)(?:\s+Vacancy|\s+View Details|$)/i;
            const vacRe = /Vacancy\s*:\s*(\d+)/i;

            const headingTextOf = (card) => {
                if (!card) return null;
                const h = card.querySelector('h1, h2, h3, h4, [class*="tracking-tight"]');
                if (h) {
                    const t = norm(h.textContent);
                    if (t) return t;
                }
                return null;
            };

            const titleFromCardText = (text) => {
                // Card text layout: "<Title>\nExperience Level: ...\nVacancy: ...\nView Details"
                const beforeExp = text.split(/Experience Level/i)[0];
                const cleaned = norm(beforeExp);
                return cleaned || null;
            };

            const departmentFor = (node) => {
                let cur = node;
                while (cur) {
                    const h2 = cur.querySelector && cur.querySelector('h2');
                    if (h2) {
                        const t = norm(h2.textContent);
                        if (t && /department/i.test(t)) return t;
                    }
                    cur = cur.parentElement;
                }
                // Fall back to nearest preceding h2 containing "Department" in doc order.
                const allH2 = Array.from(document.querySelectorAll('h2'));
                let best = null;
                for (const h2 of allH2) {
                    const t = norm(h2.textContent);
                    if (!/department/i.test(t)) continue;
                    if (h2.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
                        best = t;
                    }
                }
                return best;
            };

            const out = [];
            const seen = new Set();

            // Primary path: real job-detail anchors under /jobs/<slug>.
            const jobAnchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]'))
                .filter((a) => {
                    const href = a.getAttribute('href') || '';
                    if (!/\/jobs\/[^/?#]+/.test(href)) return false;
                    // Exclude external social links etc.
                    try {
                        const u = new URL(href, window.location.origin);
                        return u.hostname === window.location.hostname && /\/jobs\/[^/?#]+/.test(u.pathname);
                    } catch (_) {
                        return false;
                    }
                });

            for (const a of jobAnchors) {
                const href = new URL(a.getAttribute('href'), window.location.origin).toString();
                if (seen.has(href)) continue;

                const card = a.closest('[class*="rounded"]') || a.closest('div') || a.parentElement;
                const cardText = norm(card ? card.textContent : a.textContent);

                let title = headingTextOf(card);
                if (!title) title = titleFromCardText(cardText);
                if (!title) {
                    // Last resort: anchor text if it isn't "View Details".
                    const at = norm(a.textContent);
                    if (at && !/view details/i.test(at)) title = at;
                }
                if (!title) continue;

                const expMatch = cardText.match(expRe);
                const vacMatch = cardText.match(vacRe);

                seen.add(href);
                out.push({
                    title,
                    department: departmentFor(card || a),
                    experienceLevel: expMatch ? norm(expMatch[1]) : null,
                    vacancy: vacMatch ? vacMatch[1] : null,
                    url: href
                });
            }

            // Fallback path: no anchors matched (e.g. cards use JS handlers).
            // Reconstruct from "Experience Level:" markers.
            if (!out.length) {
                const markers = Array.from(document.querySelectorAll('div, p, span'))
                    .filter((el) => /Experience Level\s*:/i.test(el.textContent || '') &&
                        el.children.length <= 6);
                for (const el of markers) {
                    const text = norm(el.textContent);
                    if (!text || text.length > 500) continue;
                    const card = el.closest('[class*="rounded"]') || el.parentElement;
                    const cardText = norm(card ? card.textContent : text);
                    let title = headingTextOf(card) || titleFromCardText(cardText);
                    if (!title) continue;
                    const expMatch = cardText.match(expRe);
                    const vacMatch = cardText.match(vacRe);
                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({
                        title,
                        department: departmentFor(card || el),
                        experienceLevel: expMatch ? norm(expMatch[1]) : null,
                        vacancy: vacMatch ? vacMatch[1] : null,
                        url: null
                    });
                }
            }

            return out;
        });

        meta.listingHits = jobs.length;
        // No detail-page navigation in this extractor (see header note).
        meta.detailPagesVisited = 0;

        console.log(`? [vrittechnologies] Found ${jobs.length} job entries.`);
        safeDiscovered(progress, jobs.length);

        for (const job of jobs) {
            try {
                const descParts = [];
                if (job.department) descParts.push(`Department: ${job.department}`);
                if (job.experienceLevel) descParts.push(`Experience Level: ${job.experienceLevel}`);
                if (job.vacancy) descParts.push(`Vacancy: ${job.vacancy}`);
                const description = descParts.join(' | ');

                const tags = ['Career'];
                if (job.department) tags.push(job.department);
                if (job.experienceLevel) tags.push(job.experienceLevel);

                items.push({
                    id: `vrittechnologies-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: job.title,
                    description,
                    date: null,
                    time: null,
                    location: 'Sankhamul, Baneshwor, Kathmandu',
                    price: null,
                    organizer: 'Vrit Technologies',
                    category: job.department || 'Career',
                    tags,
                    image: null,
                    url: job.url || VRIT_JOBS_URL,
                    registrationUrl: job.url || null,
                    attendanceMode: null,
                    source: 'vrittechnologies'
                });
                console.log(`  ? [vrittechnologies] Scraped job: ${job.title}`);
            } catch (error) {
                console.error(`  ? [vrittechnologies] Error building job item:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};