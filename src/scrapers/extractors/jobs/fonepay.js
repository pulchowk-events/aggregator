// src/scrapers/extractors/jobs/fonepay.js
// Site-specific extractor for fonepay.com/career.
// See ../README.md for the contract.
//
// CONFIRMED FROM EVIDENCE:
//   - The listing page IS the careers page (title "Career | Fonepay";
//     body contains "Career at Fonepay / Make an impact with fonepay!").
//   - Detail-link pattern `/career/<slug>` is real - e.g.
//     https://fonepay.com/career/project-coordinator. The listing card
//     exposes this URL under three anchors (empty, "Apply Before:...",
//     and the role title) - we dedupe by URL.
//   - Detail page: title in h1.display-5 (evidence:
//     <h1 class="display-5 fw-bold text-fonepay">Project Coordinator</h1>).
//   - Detail description: section.blog-section.mt-0 (~4658 chars).
//   - The dump's "card wrapper" `link` (20) is HTML metadata; ignore.
//   - The dump's "detail-link pattern" `/` (8 matches) is nav links;
//     ignore. The real detail link candidates are the /career/<slug> ones.
//   - Deadline is embedded on the card as "Apply Before:<DD Mon, YYYY>".
//   - Detail JSON-LD is only WebPage / FinancialService / Organization /
//     WebSite - no JobPosting - so we scrape HTML directly.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const FONEPAY_CAREER_URL = 'https://fonepay.com/career';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [fonepay] Scraping Fonepay careers...');

        // ---- Stage 1: listing ----
        meta.pagesVisited++;
        await page.goto(FONEPAY_CAREER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [fonepay] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const listing = await page.evaluate((entryUrl) => {
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            const entryNorm = entryUrl.replace(/\/$/, '');
            const seen = new Set();
            const out = [];

            // Evidence: real job cards are anchors to /career/<slug>.
            // Exclude the /career listing itself and non-slug /career routes.
            const anchors = document.querySelectorAll('a[href*="/career/"]');
            for (const a of anchors) {
                const href = abs(a.getAttribute('href'));
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                const rel = href.replace(/^https?:\/\/[^/]+/, '');
                if (!/^\/career\/[^/?#]+/i.test(rel)) continue;

                if (seen.has(href)) continue;
                seen.add(href);

                // Find the enclosing card region so we can pull title +
                // deadline text. Use the anchor's own text first; fall back
                // to the nearest ancestor that has meaningful text.
                let titleText = clean(a.textContent);
                // "Apply Before:..." is not the title.
                if (/^apply before/i.test(titleText || '')) titleText = null;

                let scope = a.parentElement;
                for (let i = 0; i < 6 && scope && scope !== document.body; i++) {
                    const txt = (scope.textContent || '');
                    if (/apply before/i.test(txt) || (titleText && txt.length > titleText.length + 20)) break;
                    scope = scope.parentElement;
                }
                const scopeTxt = scope ? (scope.textContent || '') : '';

                // Deadline: "Apply Before:09 Oct, 2026".
                let deadlineRaw = null;
                const dM = scopeTxt.match(/Apply Before\s*:\s*([0-9]{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})/i);
                if (dM) deadlineRaw = clean(dM[1]);

                // Title fallback: if the anchor text was empty, look for an
                // h3/h4/h5 inside the scope whose text is a plausible title.
                if (!titleText && scope) {
                    for (const h of scope.querySelectorAll('h2, h3, h4, h5, strong')) {
                        const t = clean(h.textContent);
                        if (!t) continue;
                        if (/^apply before/i.test(t)) continue;
                        if (t.length < 2 || t.length > 160) continue;
                        titleText = t;
                        break;
                    }
                }

                // Also pull a teaser description if a <p> exists in scope.
                let teaser = null;
                if (scope) {
                    for (const p of scope.querySelectorAll('p')) {
                        const t = clean(p.textContent);
                        if (!t) continue;
                        if (/^apply before/i.test(t)) continue;
                        if (t.length < 20) continue;
                        teaser = t;
                        break;
                    }
                }

                // Final title from URL slug if we still have none:
                // "/career/project-coordinator" -> "Project Coordinator".
                if (!titleText) {
                    const slug = rel.split('/').filter(Boolean).pop() || '';
                    if (slug) {
                        titleText = slug
                            .split('-')
                            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                            .join(' ');
                    }
                }

                if (!titleText || titleText.length < 2 || titleText.length > 160) continue;

                out.push({
                    url: href,
                    title: titleText,
                    deadlineRaw,
                    teaser,
                });
            }
            return out;
        }, FONEPAY_CAREER_URL);

        meta.listingHits = listing.length;
        safeDiscovered(progress, listing.length);
        console.log(`? [fonepay] found ${listing.length} job listing(s)`);

        if (listing.length === 0) {
            return { items: [], meta };
        }

        // ---- Stage 2: per-job detail ----
        for (const l of listing) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(l.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800);

                const titleResult = await pickOne(page, [
                    'h1.display-5',
                    'h1[class*="display-5"]',
                    'h1',
                ], { label: `detail title (${l.url})` });

                const extras = await page.evaluate(() => {
                    const stripHtml = (s) => (s
                        ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null);

                    let description = null;
                    const descEl = document.querySelector('section.blog-section.mt-0, section.blog-section');
                    if (descEl) description = stripHtml(descEl.textContent);

                    if (!description) {
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
                        description = best;
                    }

                    // Deadline may also appear on the detail page.
                    const bodyTxt = document.body.textContent || '';
                    const dlM = bodyTxt.match(/Apply Before\s*:\s*([0-9]{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})/i);

                    return {
                        description,
                        finalUrl: window.location.href,
                        deadlineOnDetail: dlM ? dlM[1].trim() : null,
                    };
                });

                if (!titleResult.value) {
                    meta.detailParseFailures++;
                    console.warn(`?? [fonepay] detail title extraction failed for ${l.url}`);
                    continue;
                }

                // Convert "09 Oct, 2026" -> ISO if possible.
                const deadlineRaw = l.deadlineRaw || extras.deadlineOnDetail;
                let dateIso = null;
                if (deadlineRaw) {
                    const cleaned = deadlineRaw.replace(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/, '$1 $2 $3');
                    const d = new Date(cleaned);
                    if (!isNaN(d.getTime())) dateIso = d.toISOString();
                }

                items.push({
                    id: `fonepay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: titleResult.value,
                    description: extras.description || l.teaser || null,
                    date: dateIso,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Fonepay Payment Service Ltd.',
                    category: null,
                    tags: [],
                    image: null,
                    url: extras.finalUrl || l.url,
                    registrationUrl: extras.finalUrl || l.url,
                    attendanceMode: null,
                    source: 'fonepay',
                });

                console.log(`    ? [fonepay] Scraped: ${titleResult.value}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [fonepay] 403 on ${l.url} - skipping.`);
                } else {
                    console.error(`    ? [fonepay] Error on ${l.url}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [fonepay] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};