// src/scrapers/extractors/jobs/vianet.js
// Site-specific extractor for vianet.com.np/vacancy/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - Site type is single-page-cards, NOT listing-to-detail. The dump's
//     "detail-link pattern" `/` (6 matches) is nav/logo/footer routes;
//     detailLinkCandidates is empty. There are no per-job detail hrefs -
//     each role's info (title, apply-before date, vacancy count,
//     qualifications) is rendered INLINE on the listing card itself.
//     Body snippet confirms this:
//       "Vacancy Announcement / Training and Development Officer -CSSD /
//        Apply before: 2026-11-22 / No. of Vacancy(ies) 1 /
//        Qualifications Bachelor's degree in IT, Business Admin."
//   - Card wrapper (confirmed): div.p-4.border.border-slate-200.shadow-lg
//     .rounded-lg.relative.flex.flex-col.h-full - 8 instances in
//     cardGroups AND cardCandidates with hasJobishContent:true.
//   - Title (confirmed): p.font-title_bold.text-lg.text-mainColor.mb-0
//     (sample: "Training and Development Officer -CSSD").
//   - The dump's "sample detail page" (/networkcoverage/) is a marketing
//     route captured by mistake - ignore its selectors.
//   - The dump's "card wrapper" `link` (25) is HTML metadata.
//
// Strategy (single-pass, one page.evaluate):
//   1. Navigate + detectPageState.
//   2. For each career card, parse:
//        - Title from p.font-title_bold
//        - "Apply before: <date>"   date (ISO if parseable)
//        - "No. of Vacancy(ies): <n>"  tag
//        - "Qualifications/Experience/." sections  concat into description
//        - Any Apply button/link  registrationUrl
//   3. safeDiscovered + safeUnitDone, meta.listingHits.
//   4. Return [] if there are no cards.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const VIANET_VACANCY_URL = 'https://www.vianet.com.np/vacancy/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [vianet] Scraping Vianet vacancies...');

        meta.pagesVisited++;
        await page.goto(VIANET_VACANCY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [vianet] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Wait for career cards (evidence: div.p-4.border.border-slate-200.).
        try {
            await page.waitForSelector(
                'div.p-4.border.border-slate-200.shadow-lg.rounded-lg, ' +
                'div.p-4.border.border-slate-200.shadow-lg',
                { timeout: 8000 }
            );
        } catch (e) {
            console.log('?? [vianet] no career cards found - vacancy list may be empty');
        }

        // Scroll through so lazy sections mount.
        try {
            const h = await page.evaluate(() => document.body.scrollHeight);
            const steps = Math.min(8, Math.ceil(h / 800));
            for (let i = 0; i < steps; i++) {
                await page.evaluate((y) => window.scrollTo(0, y), i * 800);
                await delay(250);
            }
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(600);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(200);
        } catch (e) { /* best-effort */ }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            // ---- Card scope ----
            const cards = document.querySelectorAll(
                'div.p-4.border.border-slate-200.shadow-lg.rounded-lg, ' +
                'div.p-4.border.border-slate-200.shadow-lg'
            );

            for (const card of cards) {
                try {
                    // Title: confirmed selector p.font-title_bold
                    // (also p.font-title_bold.text-lg.text-mainColor).
                    const titleEl = card.querySelector(
                        'p.font-title_bold, p.font-title_bold.text-lg, .font-title_bold'
                    );
                    const title = titleEl ? clean(titleEl.textContent) : null;
                    if (!title || title.length < 2 || title.length > 200) continue;
                    // Skip obvious section labels that sometimes reuse the class.
                    if (/^(qualifications?|experience|requirements?|apply before|no\.? of vacanc(?:y|ies))$/i.test(title)) {
                        continue;
                    }

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const cardTxt = card.textContent || '';

                    // Apply-before date: "Apply before: 2026-11-22".
                    let dateIso = null;
                    let dateRaw = null;
                    const dlM = cardTxt.match(/(?:apply\s*before|deadline)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}|[0-9]{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})/i);
                    if (dlM) {
                        dateRaw = clean(dlM[1]);
                        const cleaned = dateRaw.replace(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/, '$1 $2 $3');
                        const d = new Date(cleaned);
                        if (!isNaN(d.getTime())) dateIso = d.toISOString();
                    }

                    // Vacancy count  tag.
                    const tags = [];
                    const vacM = cardTxt.match(/no\.?\s*of\s*vacanc(?:y|ies)\s*[:\-]?\s*(\d{1,3})/i);
                    if (vacM) tags.push(`${vacM[1]} vacancy(ies)`);

                    // Optional mode hints.
                    const modeM = cardTxt.match(/\b(Hybrid|Remote|On-?site|Onsite|In[-\s]?Office)\b/i);
                    let attendanceMode = null;
                    if (modeM) {
                        const mm = modeM[1].toLowerCase();
                        if (mm.includes('remote')) attendanceMode = 'online';
                        else if (mm.includes('hybrid')) attendanceMode = 'hybrid';
                        else attendanceMode = 'in-person';
                    }
                    if (modeM) tags.push(modeM[1]);

                    // Location hint ("City, Country" pattern).
                    const locM = cardTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);
                    const location = locM ? clean(locM[1]) : null;

                    // Description: concatenate the card text minus the
                    // structural labels we already captured, so the
                    // orchestrator gets a meaningful prose blob.
                    let description = null;
                    const descParts = [];
                    for (const p of card.querySelectorAll('p, li, div')) {
                        if (p.children.length > 0) continue; // leaf text
                        const t = clean(p.textContent);
                        if (!t) continue;
                        if (t.length < 15) continue;
                        if (t === title) continue;
                        if (/^(apply before|deadline)/i.test(t)) continue;
                        if (/^(no\.?\s*of\s*vacanc)/i.test(t)) continue;
                        if (descParts.includes(t)) continue;
                        descParts.push(t);
                    }
                    if (descParts.length) description = descParts.join(' | ');

                    // Apply control / URL. Cards on this listing do not
                    // expose per-role detail URLs; if there is a real apply
                    // anchor inside the card, capture it, else fall back to
                    // the vacancy listing URL.
                    let registrationUrl = null;
                    const applyEl = card.querySelector(
                        'a[href^="mailto:"], a[href*="apply"], a[href*="career"], a[href*="vacancy"], a.apply-btn'
                    );
                    if (applyEl) {
                        const raw = applyEl.getAttribute('href') || '';
                        if (raw && !/^(tel:|javascript:)/i.test(raw) && !/^#/.test(raw)) {
                            if (/^mailto:/i.test(raw)) registrationUrl = raw;
                            else registrationUrl = abs(raw);
                        }
                    }

                    // Also look for an "Apply" text control that might be a
                    // button/anchor without a matching href pattern.
                    if (!registrationUrl) {
                        const ctrl = Array.from(card.querySelectorAll('a, button'))
                            .find((el) => /^apply( now)?$|^apply for/i.test((el.textContent || '').trim()));
                        if (ctrl && ctrl.tagName === 'A') {
                            const raw = ctrl.getAttribute('href') || '';
                            if (raw && !/^(tel:|javascript:)/i.test(raw) && !/^#/.test(raw)) {
                                registrationUrl = /^mailto:/i.test(raw) ? raw : abs(raw);
                            }
                        }
                    }

                    out.push({
                        id: `vianet-${now}-${rand()}`,
                        title,
                        description: description ? stripHtml(description) : null,
                        date: dateIso,
                        time: null,
                        location,
                        price: null,
                        organizer: 'Vianet Communication Ltd.',
                        category: null,
                        tags,
                        image: null,
                        url: entryUrl,
                        registrationUrl: registrationUrl || entryUrl,
                        attendanceMode,
                        source: 'vianet',
                    });
                } catch (e) {
                    // skip malformed card
                }
            }
            return out;
        }, VIANET_VACANCY_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[vianet] no vacancies listed right now - returning empty list');
        } else {
            console.log(`? [vianet] extracted ${items.length} vacancy(ies)`);
        }

        return { items, meta };
    },
};