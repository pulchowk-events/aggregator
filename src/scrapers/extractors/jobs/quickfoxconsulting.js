// src/scrapers/extractors/jobs/quickfoxconsulting.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: listing-to-detail. /careers renders job cards
// (div.bg-white.rounded-xl...p-6) with an <h3> title, meta chips, and
// a "View More" button linking to /careers/<cuid>. Detail pages carry
// the full job description.
//
// Selector drift history:
//   2026-11-14: initial extractor.
//   - Card wrapper: div.bg-white.rounded-xl.border.border-neutral-200.p-6
//     (7 matches in dump) with h3.text-heading.font-bold as the title.
//   - Detail link: <a href="/careers/<cuid>">View More</a> - click text
//     is generic ("View More") so we harvest by href prefix, not text.
//   - Detail page H1 not captured in dump; use main h1 + h3 fallback.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://quickfoxconsulting.com/careers';
const ORIGIN = 'https://quickfoxconsulting.com';

const SEL = {
    detailTitle: [
        'main h1',
        'h1.text-heading',
        'h1',
        'main h2'
    ]
};

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load the careers listing ---------------------------------
        meta.pagesVisited++;
        try {
            // Next.js app keeps analytics sockets open  domcontentloaded
            await page.goto(ENTRY_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
        } catch (error) {
            console.warn(
                `?? [quickfoxconsulting] listing navigation failed: ${error.message}`
            );
            return { items, meta };
        }
        await delay(1800);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [quickfoxconsulting] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for at least one job card
        try {
            await page.waitForSelector(
                'div.bg-white.rounded-xl.border h3.text-heading',
                { timeout: 15000 }
            );
        } catch (e) {
            console.log(
                '?? [quickfoxconsulting] No job cards found on /careers.'
            );
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        // Small scroll to make sure everything is in the DOM
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let y = 0;
                    const step = () => {
                        window.scrollBy(0, 600);
                        y += 600;
                        if (y < document.body.scrollHeight && y < 10000) {
                            setTimeout(step, 80);
                        } else {
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    };
                    step();
                });
            });
            await delay(400);
        } catch (e) {
            /* non-fatal */
        }

        // --- Stage 2: harvest job cards + detail links ------------------------
        const jobCards = await page.evaluate(() => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

            // Card wrapper: any div with the shared class signature.
            // We pick by class substring to survive Tailwind class churn.
            const cards = Array.from(
                document.querySelectorAll(
                    'div.bg-white.rounded-xl.border.border-neutral-200'
                )
            );

            const out = [];
            const seenUrls = new Set();

            for (const card of cards) {
                const h3 = card.querySelector('h3');
                if (!h3) continue;
                const title = norm(h3.textContent);
                if (!title || title.length < 3) continue;

                // Detail link: any anchor with href starting /careers/<id>
                const anchors = Array.from(card.querySelectorAll('a[href]'));
                let detailHref = null;
                for (const a of anchors) {
                    const href = a.getAttribute('href') || '';
                    if (/^\/careers\/[^/]+$/i.test(href)) {
                        detailHref = new URL(
                            href,
                            window.location.origin
                        ).href;
                        break;
                    }
                }
                if (!detailHref) {
                    // Some cards may wrap the whole card in an anchor
                    const parentAnchor = card.closest('a[href]');
                    if (
                        parentAnchor &&
                        /^\/careers\/[^/]+$/i.test(
                            parentAnchor.getAttribute('href') || ''
                        )
                    ) {
                        detailHref = new URL(
                            parentAnchor.getAttribute('href'),
                            window.location.origin
                        ).href;
                    }
                }
                if (!detailHref) continue;
                if (seenUrls.has(detailHref)) continue;
                seenUrls.add(detailHref);

                // Meta chips: department / location / type / experience.
                // Shape in dump: "flex flex-wrap gap-4 text-body-sm ..."
                // with <span> children each containing an SVG + text.
                const metaSpans = Array.from(
                    card.querySelectorAll('.flex.flex-wrap.gap-4 span')
                )
                    .map((s) => norm(s.textContent))
                    .filter(Boolean);

                // Best-effort short blurb from the card (before View More)
                const cardText = norm(card.innerText);
                const blurb = cardText.replace(title, '').trim();

                out.push({
                    title,
                    detailHref,
                    metaSpans,
                    cardText,
                    blurb
                });
            }
            return out;
        });

        meta.listingHits = jobCards.length;
        safeDiscovered(progress, jobCards.length);
        console.log(
            `? [quickfoxconsulting] Found ${jobCards.length} job card(s).`
        );

        if (jobCards.length === 0) {
            return { items, meta };
        }

        // --- Stage 3: visit each job detail page -----------------------------
        for (const card of jobCards) {
            try {
                console.log(
                    `  ?? [quickfoxconsulting] Scraping job: ${card.detailHref}`
                );
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await page.goto(card.detailHref, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                });
                await delay(900);

                const titleResult = await pickOne(page, SEL.detailTitle, {
                    label: `detail title (${card.detailHref})`
                });

                let title = titleResult.value;
                // Guard against generic pages
                if (
                    !title ||
                    /^Careers?$/i.test(title) ||
                    title.length < 3
                ) {
                    title = card.title;
                }

                if (!title) {
                    meta.detailParseFailures++;
                    console.warn(
                        `?? [quickfoxconsulting] No usable title for ${card.detailHref}`
                    );
                    continue;
                }

                const extras = await page.evaluate(() => {
                    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

                    // Description: main content, then largest div fallback
                    let description = null;
                    const mainEl =
                        document.querySelector('main') ||
                        document.querySelector('article');
                    if (mainEl) {
                        const txt = norm(mainEl.innerText);
                        if (txt && txt.length > 100) description = txt;
                    }
                    if (!description) {
                        const divs = Array.from(
                            document.querySelectorAll(
                                'section, div.prose, div[class*="content"]'
                            )
                        );
                        divs.sort(
                            (a, b) => b.innerText.length - a.innerText.length
                        );
                        if (divs[0]) {
                            const txt = norm(divs[0].innerText);
                            if (txt && txt.length > 100) description = txt;
                        }
                    }

                    // Image: first non-logo image in main
                    let image = null;
                    const root =
                        document.querySelector('main') || document.body;
                    for (const img of Array.from(root.querySelectorAll('img'))) {
                        const src = window.__resolveImageSrc(img);
                        if (!src) continue;
                        if (/logo|icon|sprite|placeholder/i.test(src)) continue;
                        image = src;
                        break;
                    }

                    // Location / attendance mode from page text
                    const bodyText = norm(document.body.innerText).toLowerCase();
                    let location = null;
                    for (const city of [
                        'kathmandu',
                        'pokhara',
                        'lalitpur',
                        'bhaktapur',
                        'nepal',
                        'remote'
                    ]) {
                        if (bodyText.includes(city)) {
                            location =
                                city.charAt(0).toUpperCase() +
                                city.slice(1);
                            break;
                        }
                    }

                    let attendanceMode = 'in-person';
                    if (/\bremote\b/i.test(bodyText))
                        attendanceMode = 'online';
                    else if (/\bhybrid\b/i.test(bodyText))
                        attendanceMode = 'hybrid';

                    return {
                        description,
                        image,
                        location,
                        attendanceMode,
                        finalUrl: window.location.href
                    };
                });

                // Classify meta chips into tags
                const tags = [];
                let jobType = null;
                let locationFromChips = null;
                for (const m of card.metaSpans || []) {
                    if (!m) continue;
                    if (
                        /^(Full[\s-]?Time|Part[\s-]?Time|Internship|Contract|Freelance|Trainee)$/i.test(
                            m
                        )
                    ) {
                        jobType = m;
                        tags.push(m);
                        continue;
                    }
                    if (
                        /\b(kathmandu|pokhara|lalitpur|bhaktapur|nepal|remote)\b/i.test(
                            m
                        )
                    ) {
                        locationFromChips = m;
                        tags.push(m);
                        continue;
                    }
                    if (m.length <= 40) tags.push(m);
                }

                items.push({
                    id: `quickfoxconsulting-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title,
                    description: extras.description || card.blurb || null,
                    date: null,
                    time: null,
                    location:
                        extras.location || locationFromChips || 'Nepal',
                    price: null,
                    organizer: 'Quickfox Consulting',
                    category: jobType || null,
                    tags,
                    image: extras.image || null,
                    url: extras.finalUrl || card.detailHref,
                    registrationUrl: extras.finalUrl || card.detailHref,
                    attendanceMode: extras.attendanceMode || 'in-person',
                    source: 'quickfoxconsulting'
                });

                console.log(
                    `    ? [quickfoxconsulting] Scraped: ${title}`
                );
                await delay(500);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(
                        `?? [quickfoxconsulting] 403 on ${card.detailHref} - skipping.`
                    );
                    continue;
                }
                console.error(
                    `    ? [quickfoxconsulting] Error on ${card.detailHref}:`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};