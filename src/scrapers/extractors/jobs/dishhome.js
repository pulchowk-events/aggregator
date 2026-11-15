// src/scrapers/extractors/jobs/dishhome.js
// Site: https://career.dishhome.com.np/  (Dish Media Network Ltd. - Talent Connects board)
// Verdict: CAREERS_PAGE (job board host), but the evidence dump was captured
// pre-hydration, so the listing rendered almost no evidence:
//   - cardCandidates: []
//   - detailLinkCandidates: []
//   - fieldEvidence.fields: {}
//   - anchorGroups: 3 total, all site chrome
// What we DO have:
//   - Next.js host (scripts under /_next/static/.)
//   - cardGroups shows `span.flex.items-center` x3 containing a
//     lucide-map-pin SVG + "Nepalgunj, Nepal" - i.e. ~3 job cards exist with
//     a per-card location line, but their wrappers and titles were not
//     classified by the wizard.
//
// Strategy:
//   - Load, then let Next.js hydrate (network idle + short settle).
//   - Scroll in steps to trigger lazy-rendered cards.
//   - Harvest cards by anchoring on the *confirmed* location span
//     (`span.flex.items-center` with a lucide-map-pin SVG), then walk up to a
//     wrapper that also contains a heading (title) and a link (apply).
//   - If per-card detail links are present, follow them once for a fuller
//     description; otherwise use card body only.
//   - If nothing renders, return [] cleanly (site may simply be empty).
//
// Selector drift history:
//   2026-11-15: initial extraction. Only evidence-based selector available
//                is `span.flex.items-center` + lucide-map-pin. Everything
//                else is inferred defensively from card structure.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const DISHHOME_URL = 'https://career.dishhome.com.np/';
const DISHHOME_COMPANY = 'Dish Media Network Ltd.';

function parseCardText(text) {
    const out = {};
    if (!text) return out;

    const employment = text.match(/\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary|Freelance)\b/i);
    if (employment) out.employmentType = employment[1].replace(/\s+/g, ' ');

    const mode = text.match(/\b(Remote|On-?site|Hybrid)\b/i);
    if (mode) out.attendanceMode = mode[1].toLowerCase().replace(/-/g, '');

    const level = text.match(/\b(Junior|Mid[- ]?Level|Senior|Lead|Principal|Entry[- ]?Level)\b/i);
    if (level) out.level = level[1].replace(/\s+/g, ' ');

    const experience = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\s*\+)?)/i);
    if (experience) out.experience = experience[1].trim();

    const openings = text.match(/(\d+)\s*(?:Openings?|positions?|vacanc(?:y|ies))/i);
    if (openings) out.openings = openings[1];

    const deadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    if (deadline) out.applicationEndsRaw = deadline[1].trim();

    const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Stage 1: load + hydrate ----
        try {
            meta.pagesVisited++;
            await loadPage(page, DISHHOME_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 800 + 800);
        } catch (err) {
            console.warn(`?? [dishhome] failed to load listing: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [dishhome] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // Let Next.js hydrate / lazy sections paint.
        try {
            await page.waitForSelector('main, article, h1, h2, h3, span.flex.items-center', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // Scroll to trigger any lazy-rendered cards.
        try {
            await page.evaluate(async () => {
                const step = 600;
                const max = Math.min(document.body.scrollHeight, 4000);
                for (let y = 0; y <= max; y += step) {
                    window.scrollTo(0, y);
                    await new Promise((r) => setTimeout(r, 200));
                }
                window.scrollTo(0, 0);
            });
            await delay(600);
        } catch (e) { /* ignore */ }

        // ---- Stage 2: harvest cards ----
        // Anchor on the CONFIRMED location span (lucide-map-pin icon). Walk up
        // to a wrapper that also contains a heading and an anchor.
        const cards = await page.evaluate(() => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            const locationSpans = Array.from(document.querySelectorAll('span.flex.items-center'))
                .filter((el) => {
                    if (el.closest('header, footer, nav')) return false;
                    if (!el.querySelector('svg.lucide-map-pin')) return false;
                    const t = clean(el.textContent);
                    return t && t.length >= 3 && t.length <= 120;
                });

            const out = [];
            const seen = new Set();

            for (const span of locationSpans) {
                const location = clean(span.textContent);

                // Walk up to a card wrapper that also holds a heading + link.
                let block = span.parentElement;
                let title = null;
                let cardAnchor = null;
                let cardText = null;
                for (let depth = 0; depth < 6 && block; depth++) {
                    if (block.closest('header, footer, nav')) break;
                    const h = block.querySelector('h1, h2, h3, h4');
                    if (h) title = clean(h.textContent);
                    const a = Array.from(block.querySelectorAll('a[href]')).find((el) => {
                        const href = el.getAttribute('href') || '';
                        if (!href || href.startsWith('#')) return false;
                        if (el.closest('header, footer, nav')) return false;
                        return true;
                    });
                    if (a) {
                        try { cardAnchor = a.href; } catch (_) { /* ignore */ }
                    }
                    cardText = clean(block.innerText);
                    if (title && cardAnchor) break;
                    block = block.parentElement;
                }

                if (!title) continue;

                // Reject obvious non-job headings.
                const t = title.toLowerCase();
                if (/^(dish media network|dishhome|careers?|jobs?|apply now|view all jobs?)$/.test(t)) continue;

                const key = title + '|' + (location || '') + '|' + (cardAnchor || '');
                if (seen.has(key)) continue;
                seen.add(key);

                // Also grab a description-ish paragraph from within the block.
                let description = null;
                if (block) {
                    const paras = Array.from(block.querySelectorAll('p'));
                    const big = paras
                        .map((p) => clean(p.textContent) || '')
                        .filter((s) => s.length >= 60 && s.length <= 1200)
                        .sort((a, b) => b.length - a.length)[0];
                    if (big) description = big;
                }

                // Image within block.
                let image = null;
                if (block) {
                    const img = block.querySelector('img');
                    if (img) {
                        try { image = window.__resolveImageSrc(img); } catch (_) { /* ignore */ }
                    }
                }

                out.push({ title, location, cardAnchor, cardText, description, image });
            }

            return out;
        });

        // Fallback: if the map-pin anchor found nothing but the page clearly
        // has job-shaped links (e.g. /job(s)/.), use those. Confirmed here
        // because anchorGroups showed *no* job links, but defensive.
        let harvested = cards;
        if (harvested.length === 0) {
            const linkCards = await page.evaluate(() => {
                const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);
                const out = [];
                const seen = new Set();
                const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
                    const href = a.getAttribute('href') || '';
                    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return false;
                    if (a.closest('header, footer, nav')) return false;
                    if (!/\/jobs?\/|\/careers?\/|\/openings?\//i.test(href)) return false;
                    return true;
                });
                for (const a of anchors) {
                    const href = a.href;
                    if (seen.has(href)) continue;
                    seen.add(href);
                    const title = clean(a.textContent);
                    if (!title || title.length < 3 || title.length > 160) continue;
                    const container = a.closest('article, li, div');
                    const cardText = container ? clean(container.innerText) : title;
                    out.push({ title, location: null, cardAnchor: href, cardText, description: null, image: null });
                }
                return out;
            });
            harvested = linkCards;
        }

        meta.listingHits = harvested.length;
        safeDiscovered(progress, harvested.length);

        if (harvested.length === 0) {
            console.log('  [dishhome] extracted 0 (no job cards rendered)');
            return { items, meta };
        }

        // ---- Stage 3: per-card extraction (no guaranteed detail URL pattern;
        // use card as authoritative, follow anchor only for description when
        // the card body is thin). ----
        for (const card of harvested) {
            try {
                const cardText = card.cardText || '';
                const parsed = parseCardText(cardText);

                let description = card.description;
                let descriptionEvidence = description
                    ? 'largest paragraph inside the job card wrapper'
                    : null;

                // If card description is thin AND we have a detail link that
                // looks like a same-site job URL, try once to enrich it.
                const followDetail = !description
                    && card.cardAnchor
                    && card.cardAnchor.startsWith('https://career.dishhome.com.np/')
                    && card.cardAnchor !== DISHHOME_URL;

                if (followDetail) {
                    try {
                        meta.pagesVisited++;
                        meta.detailPagesVisited++;
                        await loadPage(page, card.cardAnchor, { waitUntil: 'networkidle2', timeout: 20000 });
                        await delay(Math.random() * 600 + 400);

                        const detail = await page.evaluate(() => {
                            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);
                            const root = document.querySelector('main, article, [role="main"]') || document.body;
                            let best = null;
                            let bestLen = 0;
                            for (const el of root.querySelectorAll('div, section, article')) {
                                if (el.closest('header, footer, nav, aside')) continue;
                                const len = (clean(el.innerText) || '').length;
                                if (len < 250) continue;
                                const parentLen = el.parentElement ? (clean(el.parentElement.innerText) || '').length : 0;
                                if (parentLen > len * 0.95) continue;
                                if (len > bestLen) { bestLen = len; best = el; }
                            }
                            return { description: best ? clean(best.innerText) : null };
                        });

                        if (detail.description) {
                            description = detail.description;
                            descriptionEvidence = 'largest leaf-ish prose block on the per-job detail page';
                        }
                        // Return to listing state for further cards - but only
                        // if more cards remain. The loop will reload listing URL
                        // next iteration if needed; we don't navigate back here
                        // to keep the code simple (each card is independent).
                    } catch (err) {
                        console.warn(`?? [dishhome] detail fetch failed for ${card.cardAnchor}: ${err.message}`);
                    }
                }

                const modeFromCard = parsed.attendanceMode
                    || (card.location && /remote|hybrid|on-?site/i.test(card.location)
                        ? card.location.match(/remote|hybrid|on-?site/i)[0].toLowerCase().replace(/-/g, '')
                        : null);

                items.push({
                    id: `dishhome-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: card.title,
                    company: DISHHOME_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name "Dish Media Network Ltd."; page chrome',
                    description: description || null,
                    description_status: description ? 'extracted' : 'extraction_failed',
                    description_evidence: descriptionEvidence
                        || 'no paragraph >=60 chars inside card wrapper and no followable same-site detail URL',
                    date: null,
                    time: null,
                    location: card.location || null,
                    location_status: card.location ? 'extracted' : 'site_absent',
                    location_evidence: card.location
                        ? 'span.flex.items-center containing lucide-map-pin SVG (confirmed in evidence dump)'
                        : 'no lucide-map-pin location span inside job card',
                    price: null,
                    organizer: DISHHOME_COMPANY,
                    category: null,
                    tags: [parsed.employmentType, parsed.level, modeFromCard].filter(Boolean),
                    image: card.image || null,
                    image_status: card.image ? 'extracted' : 'site_absent',
                    image_evidence: card.image
                        ? 'first img inside job card wrapper'
                        : 'no img inside job card wrapper',
                    url: card.cardAnchor || DISHHOME_URL,
                    registrationUrl: card.cardAnchor || DISHHOME_URL,
                    attendanceMode: modeFromCard || null,
                    source: 'dishhome',
                    employmentType: parsed.employmentType || null,
                    employmentType_status: parsed.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: parsed.employmentType
                        ? 'Full/Part/Contract/Internship token in card text'
                        : 'no employment-type token in card text',
                    applicationEndsRaw: parsed.applicationEndsRaw || null,
                    applicationEnds_status: parsed.applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: parsed.applicationEndsRaw
                        ? 'Deadline/Apply by label in card text'
                        : 'no Deadline/Apply by label in card text',
                    salary: parsed.salary || null,
                    salary_status: parsed.salary ? 'extracted' : 'site_absent',
                    salary_evidence: parsed.salary
                        ? 'salary/compensation/NPR string in card text'
                        : 'no salary/compensation string in card text',
                    experience: parsed.experience || null,
                    level: parsed.level || null,
                    openings: parsed.openings || null
                });
            } catch (err) {
                meta.detailParseFailures++;
                console.warn(`?? [dishhome] card parse failed: ${err.message}`);
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [dishhome] extracted ${items.length}`);
        return { items, meta };
    }
};