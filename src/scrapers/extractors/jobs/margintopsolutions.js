// src/scrapers/extractors/jobs/margintopsolutions.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: single-page-cards - all jobs live on /career as <li>
// rows; each row is a mailto: apply link containing the job title, type
// (Full-Time / Internship), a short blurb, and (likely) location chips.
// No detail pages exist, so we harvest everything from the listing.
//
// NOTE: the auto-detector assumed "listing-to-detail" with detail-link
// pattern "hello@margintopsolutions.com" - that is wrong. The mailto:
// anchors are apply links, not detail pages. We correct to single-page.
//
// Selector drift history:
//   2026-11-14: initial extractor. Job row = li.border-b.border-white\/10
//               containing a.group[href^="mailto:"] with a per-job
//               data shape: "NN | <type> | <title> | <blurb>".

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://www.margintopsolutions.com/career';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load the /career listing ---------------------------------
        meta.pagesVisited++;
        await page.goto(ENTRY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(800);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [margintopsolutions] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for the first job row; if absent, page is genuinely empty.
        try {
            await page.waitForSelector('li.border-b a[href^="mailto:"]', {
                timeout: 15000
            });
        } catch (e) {
            console.log(
                '?? [margintopsolutions] No job rows found on /career.'
            );
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        // Slight scroll to trigger any lazy-in animations ("rv on").
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let y = 0;
                    const step = () => {
                        window.scrollBy(0, 500);
                        y += 500;
                        if (y < document.body.scrollHeight && y < 8000) {
                            setTimeout(step, 80);
                        } else {
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    };
                    step();
                });
            });
            await delay(600);
        } catch (e) {
            /* non-fatal */
        }

        // --- Stage 2: harvest all job rows in one evaluate --------------------
        const jobs = await page.evaluate(() => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

            const rows = Array.from(
                document.querySelectorAll('li.border-b.border-white\\/10')
            );

            const out = [];
            for (const li of rows) {
                const a = li.querySelector('a[href^="mailto:"]');
                if (!a) continue;

                // Row text shape:
                //   "01 Full-Time Marketing Lead Lead our marketing initiatives and ..."
                //   "02 Internship Laravel Backend Intern Work alongside our senior ..."
                const fullText = norm(a.innerText);

                // Serial number: leading digits
                const numMatch = fullText.match(/^(\d{1,3})\s+/);
                const num = numMatch ? numMatch[1] : null;

                // Job type: Full-Time / Part-Time / Internship / Contract
                const typeMatch = fullText.match(
                    /\b(Full[\s-]?Time|Part[\s-]?Time|Internship|Contract|Freelance)\b/i
                );
                const jobType = typeMatch ? typeMatch[1].replace(/\s+/g, '-') : null;

                // Extract the title. Prefer an explicit element inside the anchor.
                // Template uses <span class="rise block"> wrappers; the title is
                // typically inside a strong/bold element or the first block <span>
                // after the type span. Fallback: slice around the type label.
                let title = null;
                const boldish = a.querySelector(
                    'strong, b, [class*="font-semibold"], [class*="font-bold"]'
                );
                if (boldish) {
                    const t = norm(boldish.textContent);
                    // Skip the type/serial spans if they were picked up.
                    if (t && !/^(Full[\s-]?Time|Part[\s-]?Time|Internship|Contract|Freelance|\d+)$/i.test(t)) {
                        title = t;
                    }
                }

                if (!title) {
                    // Fallback: strip serial + type from the front, then take
                    // everything up to the first sentence-ish break.
                    let rest = fullText;
                    if (num) rest = rest.replace(new RegExp(`^${num}\\s*`), '');
                    if (jobType) {
                        rest = rest.replace(
                            new RegExp(`^${jobType.replace(/-/g, '[\\s-]?')}\\s*`, 'i'),
                            ''
                        );
                    }
                    // Title tends to end where a longer blurb begins -
                    // find a capitalised segment of 2-6 words.
                    const m = rest.match(/^([A-Z][^\n]{2,80}?)(?=\s{1,}[A-Z][a-z])/);
                    title = norm(m ? m[1] : rest.split(/[.!?]/)[0]).slice(0, 120) || null;
                }

                // Blurb / description: the remaining text after the title.
                let description = null;
                if (title && fullText.includes(title)) {
                    const after = fullText.split(title)[1] || '';
                    const cleaned = norm(after);
                    if (cleaned) description = cleaned;
                }

                // Location - look for chips/tags within the row.
                const tagTexts = Array.from(
                    li.querySelectorAll(
                        'span, div, li'
                    )
                )
                    .map((el) => norm(el.textContent))
                    .filter(
                        (t) =>
                            t &&
                            t.length <= 60 &&
                            /\b(kathmandu|lalitpur|bhaktapur|pokhara|nepal|remote|hybrid|onsite|on-site)\b/i.test(
                                t
                            ) &&
                            !t.includes('\n')
                    );
                const location =
                    tagTexts.length > 0
                        ? tagTexts[0].replace(/^(location\s*[:\-]?\s*)/i, '')
                        : null;

                // Attendance mode - hybrid / remote / on-site hints.
                let attendanceMode = 'in-person';
                const lower = fullText.toLowerCase();
                if (/\bremote\b/.test(lower)) attendanceMode = 'online';
                else if (/\bhybrid\b/.test(lower)) attendanceMode = 'hybrid';

                // Apply URL - the mailto link with the subject preset.
                const applyHref = a.getAttribute('href') || null;

                out.push({
                    num,
                    title,
                    jobType,
                    description,
                    location,
                    attendanceMode,
                    applyHref
                });
            }

            return out.filter((j) => j.title);
        });

        meta.listingHits = jobs.length;
        safeDiscovered(progress, jobs.length);
        console.log(
            `? [margintopsolutions] Found ${jobs.length} job row(s).`
        );

        if (jobs.length === 0) {
            return { items, meta };
        }

        // --- Stage 3: build items ---------------------------------------------
        for (const job of jobs) {
            try {
                const tags = [];
                if (job.jobType) tags.push(job.jobType);
                if (job.location) tags.push(job.location);

                items.push({
                    id: `margintopsolutions-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title: job.title,
                    description: job.description || null,
                    date: null,
                    time: null,
                    location: job.location || 'Nepal',
                    price: null,
                    organizer: 'MarginTop Solutions',
                    category: job.jobType || null,
                    tags,
                    image: null,
                    url: ENTRY_URL,
                    registrationUrl: job.applyHref || ENTRY_URL,
                    attendanceMode: job.attendanceMode || 'in-person',
                    source: 'margintopsolutions'
                });

                console.log(
                    `    ? [margintopsolutions] Scraped: ${job.title}${job.jobType ? ` (${job.jobType})` : ''}`
                );
            } catch (error) {
                console.error(
                    `    ? [margintopsolutions] Error processing "${job.title}":`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};