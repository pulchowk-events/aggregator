// src/scrapers/extractors/jobs/technorio.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: WordPress + Elementor careers page. The prior attempt
// returned 0 items because the evidence dump shows NO direct job anchors
// on /career/ - the page presents category cards ("Apprenticeship",
// "Job Vacancy") that must be clicked to reveal job lists. The visible
// content at load-time is a marketing hero + category grid, not a plain
// listing of job anchors.
//
// Fix strategy (multi-layer, defensive):
//   1. domcontentloaded + generous settle (Elementor + Tawk chat widgets
//      keep sockets open  networkidle2 never resolves cleanly).
//   2. Progressive scroll to force lazy sections.
//   3. Click any tab / toggle / label matching category keywords
//      (Apprenticeship, Job Vacancy, Internship, Full Time, Part Time).
//   4. Harvest ANY /career/<slug>/. anchor (deeper than /career/).
//   5. If still nothing, harvest inline job-like headings (containing
//      engineer/developer/designer/intern/manager/etc.) inside the page.
//   6. Visit each discovered link and extract title + description.
//
// Selector drift history:
//   2026-11-14: initial robust extractor - replaces the 0-item attempt.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://technorio.com/career/';
const ORIGIN = 'https://technorio.com';

const SEL = {
    detailTitle: [
        'h1.html-h1',
        'main h1',
        'article h1',
        'h1'
    ]
};

// Category labels commonly used by this template
const CATEGORY_LABELS = [
    'apprenticeship',
    'job vacancy',
    'job vacancies',
    'internship',
    'full time',
    'part time',
    'full-time',
    'part-time',
    'openings',
    'positions'
];

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load /career/ ------------------------------------------
        meta.pagesVisited++;
        try {
            await page.goto(ENTRY_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
        } catch (error) {
            console.warn(
                `?? [technorio] navigation failed: ${error.message}`
            );
            return { items, meta };
        }
        await delay(2500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [technorio] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for any heading to appear (indicates Elementor content rendered)
        try {
            await page.waitForSelector('h1, h2, h3', { timeout: 15000 });
        } catch (e) {
            console.log(
                '?? [technorio] no headings appeared on /career/ - proceeding anyway.'
            );
        }

        // --- Stage 2: scroll to force lazy content ---------------------------
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let y = 0;
                    const step = () => {
                        window.scrollBy(0, 600);
                        y += 600;
                        if (
                            y < document.body.scrollHeight &&
                            y < 20000
                        ) {
                            setTimeout(step, 90);
                        } else {
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    };
                    step();
                });
            });
            await delay(1000);
        } catch (e) {
            /* non-fatal */
        }

        // --- Stage 3: click category tabs / toggles --------------------------
        try {
            const clicked = await page.evaluate((labels) => {
                let count = 0;
                const clickables = document.querySelectorAll(
                    'a, button, [role="tab"], [role="button"], ' +
                        '.elementor-tab-title, .elementor-toggle-title, ' +
                        '[class*="tab-title"], [class*="accordion-title"]'
                );
                for (const el of clickables) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (!t || t.length > 80) continue;
                    const matches = labels.some(
                        (l) => t === l || t.includes(l)
                    );
                    if (!matches) continue;
                    try {
                        el.click();
                        count++;
                    } catch (e) {
                        /* covered / not clickable */
                    }
                }
                return count;
            }, CATEGORY_LABELS);
            if (clicked > 0) {
                console.log(
                    `   ? [technorio] clicked ${clicked} category trigger(s).`
                );
                await delay(1800);
            }
        } catch (e) {
            /* non-fatal */
        }

        // --- Stage 4: harvest /career/<slug>/. anchors ----------------------
        const anchors = await page.$$eval('a[href]', (as) =>
            as.map((a) => ({
                href: a.href,
                text: (a.textContent || '').replace(/\s+/g, ' ').trim()
            }))
        );

        const candidates = [];
        const seen = new Set();
        for (const a of anchors) {
            if (!a.href) continue;
            let u;
            try {
                u = new URL(a.href, ORIGIN);
            } catch (e) {
                continue;
            }
            if (u.origin !== ORIGIN) continue;
            if (!/^\/career\/[^/]+/i.test(u.pathname)) continue;
            if (/^\/career\/?$/i.test(u.pathname)) continue;
            if (seen.has(u.href)) continue;
            seen.add(u.href);
            candidates.push({ href: u.href, text: a.text });
        }

        console.log(
            `   ? [technorio] discovered ${candidates.length} /career/* anchor(s).`
        );

        // --- Stage 5: inline job headings fallback ---------------------------
        let inlineJobs = [];
        if (candidates.length === 0) {
            inlineJobs = await page.evaluate(() => {
                const norm = (t) =>
                    (t || '').replace(/\s+/g, ' ').trim();
                const jobRe =
                    /(engineer|developer|designer|manager|intern|analyst|architect|specialist|consultant|officer|associate|lead|director|apprentice|trainee|executive|coordinator|programmer)/i;
                const out = [];
                const titles = new Set();
                const headings = Array.from(
                    document.querySelectorAll('h2, h3, h4, h5')
                );
                for (const h of headings) {
                    const text = norm(h.textContent);
                    if (!text || text.length < 4 || text.length > 120) continue;
                    if (!jobRe.test(text)) continue;
                    if (titles.has(text.toLowerCase())) continue;
                    titles.add(text.toLowerCase());

                    // Enclosing card
                    let card = h.parentElement;
                    for (let i = 0; i < 5 && card; i++) {
                        const ct = norm(card.innerText || '');
                        if (ct.length > 40) break;
                        card = card.parentElement;
                    }

                    let url = null;
                    const a =
                        h.closest('a[href]') ||
                        (card ? card.querySelector('a[href]') : null);
                    if (a && a.href) url = a.href;

                    out.push({
                        title: text,
                        url,
                        description: card ? norm(card.innerText) : null
                    });
                }
                return out;
            });
            console.log(
                `   ? [technorio] inline job heading harvest: ${inlineJobs.length}.`
            );
        }

        meta.listingHits = candidates.length + inlineJobs.length;
        safeDiscovered(progress, meta.listingHits);

        if (meta.listingHits === 0) {
            console.log(
                '?? [technorio] no jobs or candidates found on /career/ - returning empty.'
            );
            return { items, meta };
        }

        // --- Stage 6a: build items from inline jobs (if any) -----------------
        if (inlineJobs.length > 0) {
            for (const j of inlineJobs) {
                try {
                    items.push({
                        id: `technorio-${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2, 11)}`,
                        title: j.title,
                        description: j.description || null,
                        date: null,
                        time: null,
                        location: 'Kathmandu, Nepal',
                        price: null,
                        organizer: 'Technorio Inc.',
                        category: null,
                        tags: [],
                        image: null,
                        url: j.url || ENTRY_URL,
                        registrationUrl: j.url || ENTRY_URL,
                        attendanceMode: 'in-person',
                        source: 'technorio'
                    });
                    console.log(
                        `    ? [technorio] Scraped (inline): ${j.title}`
                    );
                } catch (err) {
                    console.error(
                        `    ? [technorio] inline card error: ${err.message}`
                    );
                } finally {
                    safeUnitDone(progress);
                }
            }
            return { items, meta };
        }

        // --- Stage 6b: visit each candidate as a job detail ------------------
        for (const c of candidates) {
            try {
                console.log(
                    `  ?? [technorio] Scraping candidate: ${c.href}`
                );
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await page.goto(c.href, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                });
                await delay(1000);

                const titleResult = await pickOne(page, SEL.detailTitle, {
                    label: `detail title (${c.href})`
                });

                let title = titleResult.value;
                // Guard against generic page headings
                if (
                    !title ||
                    /^careers?$/i.test(title) ||
                    /^technorio$/i.test(title) ||
                    title.length < 3
                ) {
                    title = c.text;
                }
                if (!title) {
                    meta.detailParseFailures++;
                    console.warn(
                        `?? [technorio] no usable title for ${c.href}`
                    );
                    continue;
                }

                const extras = await page.evaluate(() => {
                    const norm = (t) =>
                        (t || '').replace(/\s+/g, ' ').trim();

                    // Description: main/article text; fall back to the
                    // largest content div.
                    let description = null;
                    const mainEl =
                        document.querySelector('main') ||
                        document.querySelector('article');
                    if (mainEl) {
                        const txt = norm(mainEl.innerText);
                        if (txt && txt.length > 80) description = txt;
                    }
                    if (!description) {
                        const divs = Array.from(
                            document.querySelectorAll('div')
                        );
                        divs.sort(
                            (a, b) =>
                                b.innerText.length - a.innerText.length
                        );
                        if (divs[0]) {
                            const txt = norm(divs[0].innerText);
                            if (txt && txt.length > 80) description = txt;
                        }
                    }

                    // Image: first non-logo image in main content
                    let image = null;
                    const root =
                        document.querySelector('main') || document.body;
                    for (const img of Array.from(
                        root.querySelectorAll('img')
                    )) {
                        const src = window.__resolveImageSrc(img);
                        if (!src) continue;
                        if (/logo|icon|sprite|placeholder/i.test(src))
                            continue;
                        image = src;
                        break;
                    }

                    return {
                        description,
                        image,
                        finalUrl: window.location.href
                    };
                });

                items.push({
                    id: `technorio-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title,
                    description: extras.description || null,
                    date: null,
                    time: null,
                    location: 'Kathmandu, Nepal',
                    price: null,
                    organizer: 'Technorio Inc.',
                    category: null,
                    tags: [],
                    image: extras.image || null,
                    url: extras.finalUrl || c.href,
                    registrationUrl: extras.finalUrl || c.href,
                    attendanceMode: 'in-person',
                    source: 'technorio'
                });

                console.log(`    ? [technorio] Scraped: ${title}`);
                await delay(500);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(
                        `?? [technorio] 403 on ${c.href} - skipping.`
                    );
                    continue;
                }
                console.error(
                    `    ? [technorio] error on ${c.href}:`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};