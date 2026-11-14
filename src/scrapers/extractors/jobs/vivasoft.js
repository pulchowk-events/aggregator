// src/scrapers/extractors/jobs/vivasoft.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape corrected from evidence: this is NOT listing-to-detail.
// The career page is a single-page careers listing with job titles as
// H3.elementor-heading-title.elementor-size-default. No detail links exist.
// Per-unit progress still reported in finally blocks for ETA accuracy.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const VIVASOFT_ENTRY_URL = 'https://vivasoft.com.np/career/';

const SEL = {
    jobTitle: 'h3.elementor-heading-title.elementor-size-default'
};

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        await page.goto(VIVASOFT_ENTRY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(Math.random() * 1000 + 500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [vivasoft] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) {
            // best-effort diagnostics
        }

        try {
            await page.waitForSelector(SEL.jobTitle, { timeout: 10000 });
        } catch (e) {
            console.log('?? [vivasoft] No job title headings found on career page.');
            return { items, meta };
        }

        const jobs = await page.evaluate((selector) => {
            const seen = new Set();
            const out = [];
            const nodes = Array.from(document.querySelectorAll(selector));

            for (const el of nodes) {
                const title = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!title || seen.has(title)) continue;
                seen.add(title);

                // Best-effort description: only text inside the same Elementor
                // widget/container. If the site changes structure this may be
                // null; title is the required field and is still captured.
                let description = null;
                const container = el.closest('.elementor-widget-heading, .elementor-widget, .elementor-element');
                if (container) {
                    const paras = Array.from(container.querySelectorAll('p, li'))
                        .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
                        .filter(Boolean);
                    if (paras.length) description = paras.join(' ');
                }

                out.push({ title, description });
            }

            return out;
        }, SEL.jobTitle);

        meta.listingHits = jobs.length;
        console.log(`? [vivasoft] Found ${jobs.length} job titles.`);
        safeDiscovered(progress, jobs.length);

        for (const job of jobs) {
            try {
                items.push({
                    id: `vivasoft-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: job.title,
                    description: job.description || '',
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Vivasoft Nepal',
                    category: 'Career',
                    tags: ['Career'],
                    image: null,
                    url: VIVASOFT_ENTRY_URL,
                    registrationUrl: null,
                    attendanceMode: null,
                    source: 'vivasoft'
                });
                console.log(`  ? [vivasoft] Scraped job: ${job.title}`);
            } catch (error) {
                console.error(`  ? [vivasoft] Error building job item:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};