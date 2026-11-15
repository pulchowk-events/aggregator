// src/scrapers/extractors/jobs/vrittechnologies.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape: /jobs listing groups roles by department (h2
// "Creative Department", "SEO Department", "Backend Department"), each
// card showing title + "Experience Level: X" + "Vacancy: N" + a
// "View Details" link pointing to /jobs/<slug>. Detail pages carry the
// long role body. Wizard's "detail-link pattern /vrittech/" and
// "H1.max-w-full" hints came from the x.com social link and are wrong --
// corrected to /jobs/<slug> anchors and plain h1.
//
// Selector provenance:
//   - a[href^="/jobs/"]           -- observed as card links on /career
//     ("<a href=\"/jobs/seo-intern\">") and referenced by the "View
//     Details" CTA in the /jobs body snippet.
//   - div.tracking-tight.capitalize -- card title wrapper (from /career
//     card sample; /jobs renders equivalent markup via shared component).
//   - h1                          -- detail page title (x.com hint
//     rejected; use plain h1).
//   - Longest prose block in main -- description, discovered at runtime.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://www.vrittechnologies.com/jobs';
const ORIGIN = 'https://www.vrittechnologies.com';
const COMPANY = 'Vrit Technologies';
const DEFAULT_LOCATION = 'Sankhamul, Baneshwor, Kathmandu, Nepal';

function classifyEmploymentType(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t.includes('intern')) return 'internship';
    if (t.includes('trainee')) return 'internship';
    if (t.includes('part-time') || t.includes('part time')) return 'part-time';
    if (t.includes('full-time') || t.includes('full time')) return 'full-time';
    if (t.includes('contract')) return 'contract';
    return null;
}

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(Math.random() * 900 + 400);
        } catch (e) {
            console.warn(`[vrittechnologies] listing load failed: ${e.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // Client-rendered; give it a moment.
        try {
            await page.waitForSelector('a[href^="/jobs/"]', { timeout: 8000 });
        } catch (e) { /* continue */ }

        const cards = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            const anchors = document.querySelectorAll('a[href^="/jobs/"]');

            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                if (!href || href === '/jobs' || href === '/jobs/') continue;
                if (seen.has(href)) continue;

                // Find the nearest card-like container around the anchor.
                let card =
                    a.closest('[class*="rounded"]') ||
                    a.closest('[class*="card"]') ||
                    a.closest('article') ||
                    a.closest('li') ||
                    a.parentElement;

                // Title: prefer the card's capitalize tracking div, else heading.
                let titleEl = null;
                if (card) {
                    titleEl =
                        card.querySelector('div.tracking-tight') ||
                        card.querySelector('h1, h2, h3, h4');
                }
                let title = titleEl ? titleEl.textContent.trim() : null;
                if (!title) title = (a.textContent || '').trim();
                if (!title || title.length < 2 || title.length > 120) continue;
                if (/^view details$/i.test(title)) continue;

                const cardText = card
                    ? (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim()
                    : (a.innerText || '').replace(/\s+/g, ' ').trim();

                // Meta labels present in /jobs body snippet:
                //   "Experience Level: Intern"
                //   "Vacancy: 1"
                const expM = cardText.match(/Experience\s*Level\s*:?\s*([A-Za-z][^\n]{0,40})/i);
                const vacM = cardText.match(/Vacanc(?:y|ies)\s*:?\s*(\d+)/i);

                // Department: nearest preceding h2 anywhere above.
                let dept = null;
                let cursor = card;
                for (let depth = 0; depth < 8 && cursor && !dept; depth++) {
                    let prev = cursor.previousElementSibling;
                    while (prev && !dept) {
                        const h2 = prev.tagName === 'H2'
                            ? prev
                            : prev.querySelector && prev.querySelector('h2');
                        if (h2 && h2.textContent.trim()) {
                            dept = h2.textContent.trim();
                            break;
                        }
                        prev = prev.previousElementSibling;
                    }
                    cursor = cursor.parentElement;
                }

                seen.add(href);
                out.push({
                    href,
                    title,
                    experienceLevel: expM ? expM[1].trim() : null,
                    vacancy: vacM ? vacM[1] : null,
                    department: dept,
                    cardText
                });
            }
            return out;
        });

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        for (const card of cards) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                const detailUrl = card.href.startsWith('http')
                    ? card.href
                    : ORIGIN + card.href;

                await loadPage(page, detailUrl);
                await delay(Math.random() * 700 + 400);

                const detail = await page.evaluate(() => {
                    const h1 = document.querySelector('h1');
                    const title = h1 ? h1.textContent.trim() : null;

                    const scope = document.querySelector('main') || document.body;

                    // Longest prose block inside main, avoiding nav/footer.
                    let best = null;
                    let bestLen = 0;
                    const candidates = scope.querySelectorAll('article, section, div');
                    for (const el of candidates) {
                        if (el.querySelector('nav, header, footer, form')) continue;
                        const txt = (el.innerText || '').trim();
                        if (txt.length > bestLen && txt.length < 20000) {
                            bestLen = txt.length;
                            best = txt;
                        }
                    }

                    const bullets = Array.from(scope.querySelectorAll('ul li'))
                        .map(li => (li.innerText || '').trim())
                        .filter(t => t.length >= 15 && t.length <= 300);

                    let applyUrl = null;
                    const a = document.querySelector(
                        'a[href^="mailto:"], a[href*="forms."], ' +
                        'a[href*="greenhouse"], a[href*="lever"], ' +
                        'a[href*="workable"], a[href*="apply"]'
                    );
                    if (a) applyUrl = a.getAttribute('href');

                    return {
                        title,
                        longBlock: best,
                        bullets,
                        applyUrl,
                        finalUrl: window.location.href,
                        bodySnippet: (document.body.innerText || '').slice(0, 4000)
                    };
                });

                const title = card.title || detail.title;
                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                let description = null;
                if (detail.bullets && detail.bullets.length >= 4) {
                    description = detail.bullets.join('\n');
                } else if (detail.longBlock && detail.longBlock.length >= 80) {
                    description = detail.longBlock;
                } else if (detail.longBlock) {
                    description = detail.longBlock;
                }
                description = description ? cleanDescriptionText(description) : null;

                const hay = (
                    title + ' ' + (description || '') + ' ' +
                    card.cardText + ' ' + (detail.bodySnippet || '')
                ).toLowerCase();

                const employmentType =
                    classifyEmploymentType(card.experienceLevel) ||
                    classifyEmploymentType(title) ||
                    classifyEmploymentType(hay);

                const location = /remote/.test(hay)
                    ? 'Remote'
                    : /sankhamul|baneshwor|kathmandu|lalitpur/.test(hay)
                        ? DEFAULT_LOCATION
                        : null;

                const tags = [];
                if (card.department) tags.push(card.department);
                if (card.experienceLevel) tags.push(card.experienceLevel);

                const item = {
                    id: `vrittechnologies-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title,
                    company: COMPANY,
                    companyUrl: ORIGIN + '/',
                    url: detail.finalUrl || detailUrl,
                    registrationUrl: detail.applyUrl || null,
                    location,
                    description,
                    employmentType,
                    applicationEndsRaw: null,
                    salary: null,
                    image: null,
                    openings: card.vacancy || null,
                    level: card.experienceLevel || null,
                    category: card.department || null,
                    tags,
                    source: 'vrittechnologies'
                };

                if (!description) {
                    item.description_status = 'extraction_failed';
                    item.description_evidence =
                        'detail page had no prose block >=80 chars in main and ' +
                        'fewer than 4 usable <ul><li> bullets; h1 present but no body';
                }
                if (!employmentType) {
                    item.employmentType_status = 'site_absent';
                    item.employmentType_evidence =
                        'no intern/trainee/part-time/full-time/contract token in ' +
                        'card Experience Level, title, or detail body';
                }
                if (!location) {
                    item.location_status = 'site_absent';
                    item.location_evidence =
                        'no remote/Kathmandu/Sankhamul/Baneshwor token in ' +
                        'title, card text, or detail body';
                }
                if (!detail.applyUrl) {
                    item.registrationUrl_status = 'site_absent';
                    item.registrationUrl_evidence =
                        'no mailto/ATS/apply a[href]; site routes applications ' +
                        'through hr@vrittechnologies.com listed in footer chrome only';
                }
                item.applicationEndsRaw_status = 'site_absent';
                item.applicationEndsRaw_evidence =
                    'no "Apply before"/"Deadline"/"Closing" text on card or detail';
                item.salary_status = 'site_absent';
                item.salary_evidence =
                    'no salary/compensation element on card or detail page';
                item.image_status = 'site_absent';
                item.image_evidence =
                    'job cards are text-only; no per-job image in evidence';

                items.push(item);
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [vrittechnologies] extracted ${items.length}`);
        return { items, meta };
    }
};