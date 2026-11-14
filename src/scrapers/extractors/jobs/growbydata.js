// src/scrapers/extractors/jobs/growbydata.js
// Site-specific extractor for growbydata.com/career-overview/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (12 matches) is nav/logo/cookie-consent
//     links, NOT job detail links. detailLinkCandidates are all
//     /solutions/* product pages.
//   - The "card wrapper" `link` (45) is HTML metadata.
//   - The "sample detail page" in the dump is the /solutions/search-
//     intelligence/ PRODUCT page (title "Search Intelligence Software for
//     Enterprise Brands"), not a job detail - there is no per-job detail
//     URL. Jobs are inline Bootstrap accordions on the careers page itself.
//   - The REAL card is `div.accordion-group.career-box` (10 instances),
//     confirmed by cardCandidates with hasJobishContent:true and
//     jobTitleRatio:1. Sample titles: "SEO ANALYST",
//     "SENIOR SOFTWARE ENGINEER - DATA PLATFORM".
//   - Title lives in `.gbd-careers-title` inside the h3.
//   - The accordion body (`.collapse` / `#collapse-N`) holds the role
//     description (e.g. "GrowByData is looking for motivated, and talented
//     individual to join us as SEO Analyst...").
//   - Therefore: single-page-cards pattern, no detail navigation.
//
// Strategy:
//   1. Dismiss the cookie banner (click "Accept All") so it doesn't
//      intercept clicks or leave overlays.
//   2. Read all career-box accordions from the DOM. Collapsed Bootstrap
//      collapse bodies still exist in the DOM (hidden by CSS), so we can
//      extract descriptions without clicking each accordion.
//   3. Emit one item per career-box; role description from the first
//      meaningful <p>; location absent in evidence  null.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const GBD_CAREERS_URL = 'https://growbydata.com/career-overview/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [growbydata] Scraping GrowByData careers...');

        meta.pagesVisited++;
        await page.goto(GBD_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [growbydata] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Dismiss the cookie-consent overlay so the DOM is clean.
        try {
            await page.evaluate(() => {
                const acceptBtns = Array.from(document.querySelectorAll(
                    'button, a'
                )).filter((el) => /^accept(\s+all)?$/i.test((el.textContent || '').trim()));
                for (const b of acceptBtns) {
                    try { b.click(); } catch (e) { /* ignore */ }
                }
            });
            await delay(400);
        } catch (e) { /* best-effort */ }

        // Wait for the career accordions.
        try {
            await page.waitForSelector('div.accordion-group.career-box', { timeout: 8000 });
        } catch (e) {
            console.log('?? [growbydata] no .career-box accordions found - will return empty');
        }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            const boxes = document.querySelectorAll('div.accordion-group.career-box');
            for (const box of boxes) {
                try {
                    // Title: .gbd-careers-title inside h3 > a.
                    let titleEl =
                        box.querySelector('.gbd-careers-title') ||
                        box.querySelector('h3 a') ||
                        box.querySelector('h3');
                    let title = titleEl ? clean(titleEl.textContent) : null;
                    if (!title) continue;
                    // Strip any trailing collapse-icon text like "+"/"-".
                    title = title.replace(/[+\---]\s*$/, '').trim();
                    if (title.length < 2 || title.length > 160) continue;

                    // Accordion body - Bootstrap 4 collapse keeps children in
                    // the DOM, so querying works even when collapsed.
                    const body =
                        box.querySelector('.accordion-body') ||
                        box.querySelector('.collapse') ||
                        box.querySelector('[class*="accordion-content"]') ||
                        box.querySelector('[class*="career-content"]');

                    let description = null;
                    if (body) {
                        let best = null;
                        let bestLen = 0;
                        for (const p of body.querySelectorAll('p, li')) {
                            const t = stripHtml(p.textContent);
                            if (!t) continue;
                            if (t.length < 30) continue;
                            if (t.length > bestLen) { bestLen = t.length; best = t; }
                        }
                        description = best;
                        // Fallback: entire body text.
                        if (!description) {
                            const full = stripHtml(body.textContent);
                            if (full && full.length >= 30) description = full;
                        }
                    }

                    // Apply URL if present inside the box.
                    let registrationUrl = null;
                    const applyEl = box.querySelector(
                        'a[href^="mailto:"], a[href*="apply"], a[href*="career"], a[href*="job"]'
                    );
                    if (applyEl) {
                        const raw = applyEl.getAttribute('href') || '';
                        if (raw) {
                            if (/^mailto:/i.test(raw)) registrationUrl = raw;
                            else {
                                try { registrationUrl = new URL(raw, window.location.origin).href; }
                                catch (e) { registrationUrl = null; }
                            }
                        }
                    }

                    // Location hint - evidence shows Boston US / Kathmandu
                    // Nepal / Remote in the page title. Try to find a
                    // per-role location marker in the accordion body.
                    let location = null;
                    const boxTxt = box.textContent || '';
                    const locM = boxTxt.match(/\b(Remote|Kathmandu[,\s]+Nepal|Boston[,\s]+(?:US|USA|MA|Massachusetts))\b/i);
                    if (locM) location = clean(locM[1]);

                    // Attendance mode based on location hints.
                    let attendanceMode = null;
                    if (location) {
                        const lc = location.toLowerCase();
                        if (lc.includes('remote')) attendanceMode = 'online';
                        else attendanceMode = 'in-person';
                    }

                    out.push({
                        id: `growbydata-${now}-${rand()}`,
                        title,
                        description: description || null,
                        date: null,
                        time: null,
                        location,
                        price: null,
                        organizer: 'GrowByData',
                        category: null,
                        tags: [],
                        image: null,
                        url: entryUrl,
                        registrationUrl: registrationUrl || entryUrl,
                        attendanceMode,
                        source: 'growbydata',
                    });
                } catch (e) {
                    // skip malformed box
                }
            }

            return out;
        }, GBD_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[growbydata] no career-box items found - returning empty list');
        } else {
            console.log(`? [growbydata] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};