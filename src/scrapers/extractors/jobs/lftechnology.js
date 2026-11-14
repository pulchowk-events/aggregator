// src/scrapers/extractors/jobs/lftechnology.js
// Site-specific extractor for career.lftechnology.com.
// See ../README.md for the contract.
//
// CONFIRMED FROM EVIDENCE:
//   - Site type: listing-to-detail. Detail URLs are Recruitee-style
//     `/o/<slug>` - confirmed by anchorGroups AND detailLinkCandidates.
//   - Detail pages DO carry JobPosting JSON-LD with rich fields
//     (title, description, employmentType, jobLocation, jobLocationType,
//     datePosted, validThrough, baseSalary). Prefer JSON-LD; fall back
//     to H1.sc-1lss5cy-2 / div.sc-1fwbcuw-0.
//   - The listing is grouped by city (Kathmandu / Pune). Cards live in
//     div.sc-uzptka-1 - the primary anchor is `a[href^="/o/"]`
//     (title link), with a "View job" duplicate in the same card.
//   - The dump's "card wrapper" `meta` (13) is HTML metadata - ignore.
//   - The dump's "detail-link pattern" `/` (5) is nav/footer links -
//     ignore; `/o/<slug>` is the real detail pattern.
//
// Strategy:
//   1. Wait for the openings list, harvest every distinct `/o/<slug>` href.
//   2. safeDiscovered(count) then per-link: goto detail, parse JSON-LD
//      JobPosting, fall back to H1 + description div.
//   3. safeUnitDone in finally; dedupe by canonical href.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const LF_LISTING_URL = 'https://career.lftechnology.com/';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [lftechnology] Scraping Leapfrog Technology careers...');

        // ---- Stage 1: listing ----
        meta.pagesVisited++;
        await page.goto(LF_LISTING_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [lftechnology] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Wait for the openings grid (Recruitee cards).
        try {
            await page.waitForSelector('a[href^="/o/"]', { timeout: 10000 });
        } catch (e) {
            console.log('?? [lftechnology] no /o/ role links found - listing may be empty');
        }

        // Scroll to bottom to trigger any lazy-loaded city groups.
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(800);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(300);
        } catch (e) { /* best-effort */ }

        const listing = await page.evaluate((entryUrl) => {
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            const seen = new Set();
            const out = [];

            // Every distinct /o/<slug> link, plus nearby metadata pulled
            // from the enclosing card (.sc-uzptka-1 / .sc-9ufk59-*).
            const anchors = document.querySelectorAll('a[href^="/o/"], a[href*="/o/"]');
            for (const a of anchors) {
                const href = abs(a.getAttribute('href'));
                if (!href) continue;
                const path = new URL(href).pathname;
                if (!/^\/o\/[^/?#]+/i.test(path)) continue;
                if (seen.has(href)) continue;
                seen.add(href);

                // Prefer the link whose text is the role name (not "View job").
                const linkText = clean(a.textContent);
                let title = null;
                if (linkText && !/^view job$/i.test(linkText) && linkText.length <= 140) {
                    title = linkText;
                } else {
                    // Climb to the card and pull the primary role anchor.
                    const card = a.closest('.sc-uzptka-1, .sc-9ufk59-0') ||
                        a.parentElement;
                    if (card) {
                        const primary = card.querySelector('a[href^="/o/"]');
                        const t = primary ? clean(primary.textContent) : null;
                        if (t && !/^view job$/i.test(t) && t.length <= 140) title = t;
                    }
                }

                // City heading from the enclosing location group
                // (h3.sc-ejdqvv-0 in evidence: "Kathmandu" / "Pune").
                let city = null;
                let p = a.parentElement;
                for (let i = 0; i < 8 && p && p !== document.body; i++) {
                    const h3 = p.querySelector && p.querySelector('h3.sc-ejdqvv-0, h3');
                    if (h3) { city = clean(h3.textContent); break; }
                    p = p.parentElement;
                }

                // Card text has "Hybrid|Remote|On-site" + "Kathmandu, Bagmati, Nepal".
                const scope = a.closest('.sc-uzptka-1, .sc-9ufk59-0') || a.parentElement;
                const scopeTxt = scope ? (scope.textContent || '') : '';

                let mode = null;
                const modeM = scopeTxt.match(/\b(Hybrid|Remote|On-?site|Onsite)\b/i);
                if (modeM) mode = modeM[1];

                let location = null;
                const locM = scopeTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?)\b/);
                if (locM) location = clean(locM[1]);
                else if (city) location = city;

                let category = null;
                const catM = scopeTxt.match(/\b(Development|Engineering|Design|Product|QA|Operations|Marketing|Sales|Data|Security)\b/);
                if (catM) category = catM[1];

                out.push({
                    url: href,
                    title: title || null,
                    location,
                    mode,
                    category,
                });
            }
            return out;
        }, LF_LISTING_URL);

        meta.listingHits = listing.length;
        safeDiscovered(progress, listing.length);
        console.log(`? [lftechnology] found ${listing.length} role listing(s)`);

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

                const detail = await page.evaluate(() => {
                    const clean = (s) => (s
                        ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                        : null);
                    const stripHtml = (s) => (s
                        ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null);

                    // ---- Prefer JSON-LD JobPosting ----
                    let ld = null;
                    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                        let parsed;
                        try { parsed = JSON.parse(s.textContent); }
                        catch { continue; }
                        const nodes = Array.isArray(parsed)
                            ? parsed
                            : (parsed && parsed['@graph']) || [parsed];
                        for (const node of nodes) {
                            if (!node) continue;
                            const t = node['@type'];
                            const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                            if (isJob) { ld = node; break; }
                        }
                        if (ld) break;
                    }

                    // ---- HTML fallbacks ----
                    const h1 = document.querySelector('h1.sc-1lss5cy-2, h1[class*="sc-1lss5cy-2"], h1');
                    const h1Text = h1 ? clean(h1.textContent) : null;

                    let htmlDescription = null;
                    const descEl = document.querySelector('div.sc-1fwbcuw-0, div[class*="sc-1fwbcuw-0"]');
                    if (descEl) htmlDescription = stripHtml(descEl.textContent);
                    if (!htmlDescription) {
                        let best = null;
                        let bestLen = 0;
                        for (const d of document.querySelectorAll('section, article, div')) {
                            if (d.closest('nav, header, footer')) continue;
                            if (d.children.length > 40) continue;
                            const txt = d.textContent || '';
                            if (txt.length <= bestLen) continue;
                            if (txt.length < 200 || txt.length > 20000) continue;
                            if (!/responsibilit|requirement|qualification|experience|skills?/i.test(txt)) continue;
                            best = stripHtml(txt);
                            bestLen = txt.length;
                        }
                        htmlDescription = best;
                    }

                    return {
                        ld,
                        h1Text,
                        htmlDescription,
                        finalUrl: window.location.href,
                    };
                });

                const ld = detail.ld || {};

                // Title
                const ldTitle = ld.title || ld.name;
                const title = clean(ldTitle) || detail.h1Text;

                if (!title) {
                    meta.detailParseFailures++;
                    console.warn(`?? [lftechnology] detail title extraction failed for ${l.url}`);
                    continue;
                }

                // Description
                const ldDesc = ld.description ? String(ld.description) : null;
                const description = ldDesc
                    ? ldDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                    : detail.htmlDescription;

                // Location
                let location = l.location || null;
                const jl = ld.jobLocation;
                const jlArr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                for (const entry of jlArr) {
                    const addr = entry && entry.address;
                    if (!addr) continue;
                    const parts = [
                        addr.addressLocality,
                        addr.addressRegion,
                        addr.addressCountry,
                    ].filter(Boolean).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean);
                    if (parts.length) { location = parts.join(', '); break; }
                }

                // Attendance mode
                const modeStr = (
                    (ld.jobLocationType || '') + ' ' + (l.mode || '')
                ).toLowerCase();
                let attendanceMode = null;
                if (modeStr.includes('telecommute') || modeStr.includes('remote')) attendanceMode = 'online';
                else if (modeStr.includes('hybrid')) attendanceMode = 'hybrid';
                else if (modeStr.trim()) attendanceMode = 'in-person';

                // Category / tags
                const category = l.category || null;
                const tags = [];
                if (ld.employmentType) {
                    const et = Array.isArray(ld.employmentType) ? ld.employmentType : [ld.employmentType];
                    for (const e of et) if (e) tags.push(String(e));
                }

                // Date - prefer validThrough (closing) else datePosted.
                let date = null;
                const rawDate = ld.validThrough || ld.datePosted || null;
                if (rawDate) {
                    const d = new Date(rawDate);
                    if (!isNaN(d.getTime())) date = d.toISOString();
                }

                items.push({
                    id: `lftechnology-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title,
                    description: description || null,
                    date,
                    time: null,
                    location,
                    price: null,
                    organizer: 'Leapfrog Technology',
                    category,
                    tags,
                    image: null,
                    url: detail.finalUrl || l.url,
                    registrationUrl: detail.finalUrl || l.url,
                    attendanceMode,
                    source: 'lftechnology',
                });

                console.log(`    ? [lftechnology] Scraped: ${title}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [lftechnology] 403 on ${l.url} - skipping.`);
                } else {
                    console.error(`    ? [lftechnology] Error on ${l.url}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [lftechnology] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};