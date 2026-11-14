// src/scrapers/extractors/jobs/vivekahealth.js
// Site-specific extractor. See ../README.md for the contract.
//
// Corrected assumption from evidence: the entry URL is a careers page, but
// it is NOT listing-to-detail for jobs. The only "detail links" on the page
// are site navigation (/solutions/..., /about/..., etc.), not job posts.
// Job descriptions appear as paragraphs on the careers page itself.
// Extraction is therefore single-page + HTML heuristic: find job-like
// paragraphs, attach the nearest preceding non-generic heading as title.
//
// Limitation: no job detail links, no JobPosting JSON-LD. If the careers
// page structure changes (titles no longer headings, descriptions no longer
// <p>), items will drop rather than emit low-confidence titles.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const VIVEKA_ENTRY_URL = 'https://www.vivekahealth.com/about/careers/';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        await page.goto(VIVEKA_ENTRY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(Math.random() * 1000 + 500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [vivekahealth] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) {
            // best-effort diagnostics
        }

        try {
            await page.waitForFunction(
                () => document.body && document.body.innerText.length > 200,
                { timeout: 10000 }
            );
        } catch (e) {
            console.log('?? [vivekahealth] Page body did not reach expected size; continuing with best-effort extraction.');
        }

        const jobs = await page.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

            const genericHeading = /find your next|our goal|careers|about|solutions|resources|contact|better technology|supercharge|automation, accuracy/i;
            const introText = /our goal:|we are a cutting-edge|improve the health and well-being of our members/i;

            const isJobDescription = (text) => {
                if (!text || text.length < 80 || text.length > 1500) return false;
                if (introText.test(text)) return false;
                return /(experience|develop|manage|lead|analy[sz]e|design|build|collaborate|responsible|requirements|qualifications|team|data|engineer|software|cloud|health|implement|maintain|support|pipeline|stakeholder)/i.test(text);
            };

            const main = document.querySelector('main') || document.body;
            const paragraphs = Array.from(main.querySelectorAll('p'));
            const headings = Array.from(main.querySelectorAll('h1,h2,h3,h4,h5,h6'))
                .map((h) => ({ el: h, text: norm(h.textContent) }))
                .filter((h) => h.text && h.text.length > 2 && h.text.length < 120 && !genericHeading.test(h.text));

            const seenTitles = new Set();
            const out = [];

            for (const p of paragraphs) {
                const description = norm(p.textContent);
                if (!isJobDescription(description)) continue;

                let title = null;

                // Nearest preceding heading in document order within main.
                for (const h of headings) {
                    if (h.el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) {
                        title = h.text;
                    }
                }

                // Fallback: previous sibling heading / strong / bold.
                if (!title) {
                    let sibling = p.previousElementSibling;
                    while (sibling) {
                        if (/^(H[1-6]|STRONG|B)$/.test(sibling.tagName)) {
                            const candidate = norm(sibling.textContent);
                            if (candidate) {
                                title = candidate;
                                break;
                            }
                        }
                        sibling = sibling.previousElementSibling;
                    }
                }

                // Last resort: a strong/bold label inside the paragraph.
                if (!title) {
                    const strong = p.querySelector('strong, b');
                    if (strong) title = norm(strong.textContent);
                }

                if (!title) continue;

                title = title.replace(/[:\---]\s*$/, '').trim();
                if (!title || genericHeading.test(title)) continue;

                const dedupeKey = title.toLowerCase();
                if (seenTitles.has(dedupeKey)) continue;
                seenTitles.add(dedupeKey);

                out.push({ title, description });
            }

            return out;
        });

        meta.listingHits = jobs.length;
        console.log(`? [vivekahealth] Found ${jobs.length} job entries.`);
        safeDiscovered(progress, jobs.length);

        for (const job of jobs) {
            try {
                items.push({
                    id: `vivekahealth-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: job.title,
                    description: job.description || '',
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Viveka Health',
                    category: 'Career',
                    tags: ['Career'],
                    image: null,
                    url: VIVEKA_ENTRY_URL,
                    registrationUrl: null,
                    attendanceMode: null,
                    source: 'vivekahealth'
                });
                console.log(`  ? [vivekahealth] Scraped job: ${job.title}`);
            } catch (error) {
                console.error(`  ? [vivekahealth] Error building job item:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};