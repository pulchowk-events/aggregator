// src/scrapers/extractors/jobs/skybase.js
// Site-specific extractor for skybase.com.np/careers.
// See ../README.md for the contract.
//
// CONFIRMED FROM EVIDENCE:
//   - Card wrapper: a.careers-job - 5 matches, jobTitleRatio:1
//     (verified by cardCandidates and cardGroups).
//   - Title: h2.careers-job-title.
//   - Category tag: .careers-job-tag (sample: "Internships"), and the
//     card also carries data-category="internships".
//   - Detail links: /careers/<slug> - verified on card href
//     ("https://www.skybase.com.np/careers/flutter-developer").
//   - Page-level: "5 open roles / Pokhara, Nepal / On-site & hybrid".
//   - Filter chips (.careers-chip) report live counts per team:
//     All 5, Design 0, Development 0, Management 0, QA 0, Internships 3,
//     Marketing 2 - so 5 cards is the complete set (no pagination).
//   - The dump's "card wrapper" `script` (16) is HTML metadata; ignore.
//   - The dump's "detail-link pattern" `/` (4) is nav/logo + one external
//     (skill361.com) - ignore; /careers/<slug> is the real detail pattern.
//   - The "sample detail page" in the dump is the SAME careers page - no
//     per-job detail DOM evidence. So detail extraction is defensive:
//     prefer card data, enrich from detail page when reachable.
//
// Strategy:
//   1. On listing: harvest every a.careers-job (title, category, tag,
//      location hinted by page text). safeDiscovered(count).
//   2. Per card: goto detail page, prefer h1 / .careers-job-title for the
//      canonical title, then the longest prose block for description.
//      On detail failure, keep the listing-card item (title from card).
//   3. safeUnitDone in finally per item.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const SKYBASE_CAREERS_URL = 'https://www.skybase.com.np/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [skybase] Scraping Skybase Innovations careers...');

        // ---- Stage 1: listing ----
        meta.pagesVisited++;
        await page.goto(SKYBASE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [skybase] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Wait for the a.careers-job cards to render.
        try {
            await page.waitForSelector('a.careers-job', { timeout: 8000 });
        } catch (e) {
            console.log('?? [skybase] no a.careers-job cards found - listing may be empty');
        }

        const listing = await page.evaluate((entryUrl) => {
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            // Page-level location & mode, e.g. "Pokhara, Nepal" + "On-site & hybrid".
            const bodyTxt = (document.body && document.body.innerText) || '';
            const pageLocM = bodyTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);
            const pageLocation = pageLocM ? clean(pageLocM[1]) : null;
            const pageModeM = bodyTxt.match(/\b(On-?site\s*&\s*hybrid|On-?site|Hybrid|Remote)\b/i);

            const out = [];
            const seen = new Set();

            for (const a of document.querySelectorAll('a.careers-job')) {
                const href = abs(a.getAttribute('href'));
                if (!href) continue;
                if (seen.has(href)) continue;
                seen.add(href);

                const titleEl = a.querySelector('h2.careers-job-title, .careers-job-title, h1, h2, h3');
                const title = titleEl ? clean(titleEl.textContent) : null;
                if (!title || title.length < 2 || title.length > 160) continue;

                const tagEl = a.querySelector('.careers-job-tag, .careers-job-meta span');
                const category = tagEl ? clean(tagEl.textContent) : null;

                const dataCategory = a.getAttribute('data-category');

                // Tags: also pick up things like "INTERN" / "FULL-TIME" if present.
                const tags = [];
                for (const t of a.querySelectorAll('.careers-job-tag, .careers-job-badge, [class*="tag"]')) {
                    const txt = clean(t.textContent);
                    if (txt && txt.length <= 40 && !tags.includes(txt)) tags.push(txt);
                }

                // Per-card mode + location if declared; else inherit page-level.
                const cardTxt = a.textContent || '';
                const cardModeM = cardTxt.match(/\b(On-?site|Hybrid|Remote)\b/i);
                const cardLocM = cardTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);

                out.push({
                    url: href,
                    title,
                    category: category || (dataCategory ? dataCategory[0].toUpperCase() + dataCategory.slice(1) : null),
                    tags,
                    location: cardLocM ? clean(cardLocM[1]) : pageLocation,
                    mode: cardModeM ? cardModeM[1] : (pageModeM ? pageModeM[1] : null),
                });
            }
            return out;
        }, SKYBASE_CAREERS_URL);

        meta.listingHits = listing.length;
        safeDiscovered(progress, listing.length);
        console.log(`? [skybase] found ${listing.length} role listing(s)`);

        if (listing.length === 0) {
            return { items: [], meta };
        }

        // ---- Stage 2: per-role detail ----
        for (const l of listing) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(l.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(700);

                const titleResult = await pickOne(page, [
                    'h1.careers-job-title',
                    'h1',
                    'h2.careers-job-title',
                    'h2',
                ], { label: `detail title (${l.url})` });

                const extras = await page.evaluate(() => {
                    const stripHtml = (s) => (s
                        ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null);

                    // Prefer explicit long-form containers if present.
                    let description = null;
                    const prefer = document.querySelector(
                        '.careers-job-detail, .careers-job-content, .job-description, .careers-single-body'
                    );
                    if (prefer) description = stripHtml(prefer.textContent);

                    if (!description) {
                        let best = null;
                        let bestLen = 0;
                        for (const d of document.querySelectorAll('section, article, div, main')) {
                            if (d.closest('nav, header, footer')) continue;
                            if (d.children.length > 40) continue;
                            const txt = d.textContent || '';
                            if (txt.length <= bestLen) continue;
                            if (txt.length < 200 || txt.length > 20000) continue;
                            if (!/responsibilit|requirement|qualification|experience|skills?|what you['']?ll do|about the role/i.test(txt)) continue;
                            best = stripHtml(txt);
                            bestLen = txt.length;
                        }
                        description = best;
                    }

                    const bodyTxt = (document.body && document.body.innerText) || '';
                    const locM = bodyTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);
                    const modeM = bodyTxt.match(/\b(On-?site\s*&\s*hybrid|On-?site|Hybrid|Remote)\b/i);

                    return {
                        description,
                        locationOnDetail: locM ? locM[1].trim() : null,
                        modeOnDetail: modeM ? modeM[1] : null,
                        finalUrl: window.location.href,
                    };
                });

                const title = titleResult.value || l.title;
                if (!title) {
                    meta.detailParseFailures++;
                    console.warn(`?? [skybase] detail title extraction failed for ${l.url}`);
                    continue;
                }

                const location = l.location || extras.locationOnDetail || null;
                const modeStr = (l.mode || extras.modeOnDetail || '').toLowerCase();
                let attendanceMode = null;
                if (modeStr.includes('hybrid')) attendanceMode = 'hybrid';
                else if (modeStr.includes('remote')) attendanceMode = 'online';
                else if (modeStr.includes('on-site') || modeStr.includes('onsite') || modeStr.includes('on site')) attendanceMode = 'in-person';

                items.push({
                    id: `skybase-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title,
                    description: extras.description || null,
                    date: null,
                    time: null,
                    location,
                    price: null,
                    organizer: 'Skybase Innovations',
                    category: l.category || null,
                    tags: l.tags || [],
                    image: null,
                    url: extras.finalUrl || l.url,
                    registrationUrl: extras.finalUrl || l.url,
                    attendanceMode,
                    source: 'skybase',
                });

                console.log(`    ? [skybase] Scraped: ${title}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [skybase] 403 on ${l.url} - skipping.`);
                } else {
                    console.error(`    ? [skybase] Error on ${l.url}:`, error.message);
                }
                // Even on detail failure, keep the listing card item so we
                // don't lose the role entirely.
                try {
                    items.push({
                        id: `skybase-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                        title: l.title,
                        description: null,
                        date: null,
                        time: null,
                        location: l.location || null,
                        price: null,
                        organizer: 'Skybase Innovations',
                        category: l.category || null,
                        tags: l.tags || [],
                        image: null,
                        url: l.url,
                        registrationUrl: l.url,
                        attendanceMode: (() => {
                            const m = (l.mode || '').toLowerCase();
                            if (m.includes('hybrid')) return 'hybrid';
                            if (m.includes('remote')) return 'online';
                            if (m.includes('on')) return 'in-person';
                            return null;
                        })(),
                        source: 'skybase',
                    });
                } catch (e) { /* ignore */ }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [skybase] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};