// src/scrapers/extractors/jobs/neptechpal.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: listing-to-detail. /careers lists job cards with links
// to /careers/<slug>; each detail page carries the full description.
//
// Selector drift history:
//   2026-11-14: initial extractor.
//   - Listing job card anchor: a[href^="/careers/"] containing
//     h3.font-bold.text-xl.text-blue-500. NOTE: the page also has
//     "Life at" cards under /careers/neptechpal/<slug> - those are
//     culture pages, not jobs. We filter to exactly 2 path segments
//     (i.e. "/careers/<slug>") to exclude them.
//   - Detail title: H1. The listing-page H1 is "Careers At NepTechPal";
//     per-job H1s on real detail pages carry the job title. Fallback to
//     the h3 from the listing when H1 is generic.
//   - Detail evidence dump was not captured (only listing returned);
//     we use conservative H1 + main-text selectors and rely on the
//     listing-provided title + metadata when the detail page is thin.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://neptechpal.com.np/careers';
const ORIGIN = 'https://neptechpal.com.np';

// Titles of "Life at" / generic culture pages that are not job postings
// (defensive: path filter should already exclude these).
const NON_JOB_SLUG_BLOCKLIST = new Set([
    'neptechpal',
    'flexible-work-hours',
    'supportive-work-culture'
]);

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load the /careers listing ---------------------------------
        meta.pagesVisited++;
        try {
            await page.goto(ENTRY_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
        } catch (error) {
            console.warn(
                `?? [neptechpal] listing navigation failed: ${error.message}`
            );
            return { items, meta };
        }
        await delay(1200);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [neptechpal] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for at least one job H3. If absent, page is genuinely empty.
        try {
            await page.waitForSelector('h3.font-bold.text-xl.text-blue-500', {
                timeout: 15000
            });
        } catch (e) {
            console.log(
                '?? [neptechpal] No job title H3s found on /careers.'
            );
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        // Scroll to trigger any lazy content / animations
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let y = 0;
                    const step = () => {
                        window.scrollBy(0, 600);
                        y += 600;
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
            await delay(500);
        } catch (e) {
            /* non-fatal */
        }

        // --- Stage 2: harvest job cards from the listing ----------------------
        const jobCards = await page.evaluate((blocklistArr) => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
            const blocklist = new Set(blocklistArr);
            const out = [];
            const seen = new Set();

            const anchors = Array.from(
                document.querySelectorAll('a[href^="/careers/"]')
            );
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                const parts = href.split('/').filter(Boolean);
                // Must be exactly ["careers", "<slug>"]
                if (parts.length !== 2) continue;
                if (parts[0] !== 'careers') continue;
                const slug = parts[1];
                if (!slug) continue;
                if (blocklist.has(slug)) continue;

                const h3 = a.querySelector('h3');
                if (!h3) continue;
                const title = norm(h3.textContent);
                if (!title) continue;

                const absHref = new URL(href, window.location.origin).href;
                if (seen.has(absHref)) continue;
                seen.add(absHref);

                const cardText = norm(a.innerText);

                // Card text sample shape:
                //   "Digital Marketing Intern Aug 17, 2026 Internship
                //    0-1 year (freshers welcome) years 2 Openings
                //    Social Media ..."
                // Best-effort metadata; individual field extraction is done
                // in JS here so it survives template tweaks.
                out.push({
                    href: absHref,
                    title,
                    cardText
                });
            }
            return out;
        }, Array.from(NON_JOB_SLUG_BLOCKLIST));

        meta.listingHits = jobCards.length;
        safeDiscovered(progress, jobCards.length);
        console.log(
            `? [neptechpal] Found ${jobCards.length} job card(s) on /careers.`
        );

        if (jobCards.length === 0) {
            return { items, meta };
        }

        // --- Stage 3: per-job detail page --------------------------------------
        const SEL = {
            detailTitle: [
                'main h1',
                'h1.text-xl',
                'h1'
            ]
        };

        for (const card of jobCards) {
            try {
                console.log(`  ?? [neptechpal] Scraping job: ${card.href}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await page.goto(card.href, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                });
                await delay(700);

                const titleResult = await pickOne(page, SEL.detailTitle, {
                    label: `detail title (${card.href})`
                });

                // Reject the site's generic listing H1 if it leaked through.
                let title = titleResult.value;
                if (
                    !title ||
                    /^Careers At NepTechPal$/i.test(title) ||
                    /^Careers$/i.test(title)
                ) {
                    title = card.title;
                }

                if (!title) {
                    meta.detailParseFailures++;
                    console.warn(
                        `?? [neptechpal] No usable title for ${card.href}`
                    );
                    continue;
                }

                const extras = await page.evaluate(() => {
                    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
                    const getText = (el) => (el ? norm(el.innerText) : null);

                    // Description: prefer <main>, else the largest content
                    // block we can find. No evidence dump available for
                    // detail, so use safe fallbacks only.
                    let description = null;
                    const mainEl =
                        document.querySelector('main') ||
                        document.querySelector('article');
                    if (mainEl) {
                        const text = getText(mainEl);
                        if (text && text.length > 80) description = text;
                    }
                    if (!description) {
                        // Fallback: concatenate <p> tags inside the first
                        // large section-ish div.
                        const divs = Array.from(document.querySelectorAll('div'));
                        divs.sort((a, b) => b.innerText.length - a.innerText.length);
                        const biggest = divs[0];
                        if (biggest) {
                            const text = getText(biggest);
                            if (text) description = text;
                        }
                    }

                    // Location - city match in page text
                    const bodyText = norm(document.body.innerText).toLowerCase();
                    let location = null;
                    for (const city of ['pokhara', 'kathmandu', 'lalitpur', 'nepal', 'remote']) {
                        if (bodyText.includes(city)) {
                            location =
                                city.charAt(0).toUpperCase() + city.slice(1);
                            break;
                        }
                    }

                    // Attendance mode from page text
                    let attendanceMode = 'in-person';
                    if (/\bremote\b/i.test(bodyText)) attendanceMode = 'online';
                    else if (/\bhybrid\b/i.test(bodyText))
                        attendanceMode = 'hybrid';

                    // Image - first non-logo image inside main
                    let image = null;
                    const imgRoot =
                        document.querySelector('main') || document.body;
                    const imgs = Array.from(imgRoot.querySelectorAll('img'));
                    for (const img of imgs) {
                        const src = window.__resolveImageSrc(img);
                        if (!src) continue;
                        if (/logo|icon|sprite|placeholder/i.test(src)) continue;
                        image = src;
                        break;
                    }

                    return {
                        description,
                        location,
                        attendanceMode,
                        image,
                        finalUrl: window.location.href
                    };
                });

                // Parse metadata from listing card text (fallbacks).
                const metaInfo = parseCardMeta(card.cardText);

                const tags = [];
                if (metaInfo.jobType) tags.push(metaInfo.jobType);
                if (metaInfo.experience) tags.push(metaInfo.experience);

                items.push({
                    id: `neptechpal-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title,
                    description: extras.description || null,
                    date: metaInfo.date || null,
                    time: null,
                    location: extras.location || 'Pokhara',
                    price: null,
                    organizer: 'Nep Tech Pal Pvt. Ltd.',
                    category: metaInfo.jobType || null,
                    tags,
                    image: extras.image || null,
                    url: extras.finalUrl || card.href,
                    registrationUrl: extras.finalUrl || card.href,
                    attendanceMode: extras.attendanceMode || 'in-person',
                    source: 'neptechpal'
                });

                console.log(`    ? [neptechpal] Scraped: ${title}`);
                await delay(500);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(
                        `?? [neptechpal] 403 on ${card.href} - skipping.`
                    );
                    continue;
                }
                console.error(
                    `    ? [neptechpal] Error on ${card.href}:`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};

// --- Helpers --------------------------------------------------------------

/**
 * Parse date / job type / experience from the listing-card innerText.
 * Example shape:
 *   "Digital Marketing Intern Aug 17, 2026 Internship
 *    0-1 year (freshers welcome) years 2 Openings Social Media ..."
 */
function parseCardMeta(cardText) {
    const out = { date: null, jobType: null, experience: null };
    if (!cardText) return out;
    const text = cardText.replace(/\s+/g, ' ').trim();

    // Date: "Aug 17, 2026" / "Aug 17, 2026" etc.
    const dateMatch = text.match(
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/
    );
    if (dateMatch) out.date = dateMatch[0];

    // Job type
    const typeMatch = text.match(
        /\b(Full[\s-]?Time|Part[\s-]?Time|Internship|Contract|Freelance|Trainee)\b/i
    );
    if (typeMatch) out.jobType = typeMatch[1];

    // Experience: "0-1 year", "2+ years", "freshers welcome"
    const expMatch = text.match(
        /(\d+\s*[--]\s*\d+\s*years?|\d+\+?\s*years?|freshers?\s+welcome)/i
    );
    if (expMatch) out.experience = expMatch[1];

    return out;
}