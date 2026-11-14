// src/scrapers/extractors/jobs/esignature.js
// Site-specific extractor for esignature.com.np/careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (7 matches) is nav/logo links, NOT
//     job detail links.
//   - The "card wrapper" `link` (23 instances) is HTML metadata.
//   - The "detail title element" H2._9vd5 and "longest description"
//     div._2ywh._li._9kh2 in the sample-detail dump come from a
//     WhatsApp share page (api.whatsapp.com), NOT from the site - the
//     dump mistakenly followed a wa.me link. Ignore both.
//   - THE REAL CARD IS `div.openP` (12 matches), with the role title in
//     `p.subt1`, e.g. "Digital Content Writer - 04". This is confirmed
//     by the cardGroups sample AND the cardCandidates entry with
//     hasJobishContent:true and the exact sample HTML.
//   - All apply buttons link to /career/job-apply - one shared apply
//     form, so per-role detail navigation is NOT needed. The listing
//     itself is the source of truth.
//
// Strategy (single-pass, no detail navigation):
//   - Wait for the accordion-style role list to render.
//   - For each div.openP: pull title from p.subt1, extract the "- NN"
//     openings count, pull category / experience / description from the
//     collapsed body if visible, and use /career/job-apply as
//     registrationUrl.
//   - Return [] gracefully if div.openP count is 0.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ESIGNATURE_CAREERS_URL = 'https://esignature.com.np/careers';
const ESIGNATURE_APPLY_URL = 'https://esignature.com.np/career/job-apply';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [esignature] Scraping eSignature careers...');

        meta.pagesVisited++;
        await page.goto(ESIGNATURE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [esignature] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Wait for the role accordion if it exists.
        try {
            await page.waitForSelector('div.openP', { timeout: 8000 });
        } catch (e) {
            console.log('?? [esignature] no div.openP role list found - will return empty');
        }

        // Expand all accordions so the collapsed body becomes visible. The
        // dump shows `data-toggle="collapse"` on `.c-open__list-title`;
        // clicking each toggles its body open.
        try {
            await page.evaluate(() => {
                const triggers = Array.from(document.querySelectorAll(
                    '.c-open__list-title[data-toggle="collapse"], .openP [data-toggle="collapse"]'
                ));
                for (const t of triggers) {
                    try { t.click(); } catch (e) { /* ignore */ }
                }
            });
            await delay(800);
        } catch (e) { /* best-effort */ }

        const items = await page.evaluate((entryUrl, applyUrl) => {
            const out = [];
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            const cards = Array.from(document.querySelectorAll('div.openP'));
            for (const card of cards) {
                try {
                    // Title from p.subt1 (confirmed in dump).
                    const titleEl = card.querySelector('p.subt1, .c-open__list-title p, .c-open__list-title');
                    let rawTitle = titleEl ? clean(titleEl.textContent) : null;
                    if (!rawTitle) continue;

                    // Split off trailing "- NN" openings suffix like
                    // "Digital Content Writer - 04".
                    let openings = null;
                    const openM = rawTitle.match(/\s*[--]\s*0*(\d{1,3})\s*$/);
                    let title = rawTitle;
                    if (openM) {
                        openings = parseInt(openM[1], 10);
                        title = rawTitle.slice(0, rawTitle.length - openM[0].length).trim();
                    }
                    if (!title || title.length < 2 || title.length > 140) continue;

                    // Card body (the collapsible region), if present.
                    const body =
                        card.querySelector('.collapse, [class*="collapse"], .c-open__list-body, .c-open__list-content') ||
                        card;

                    // Description: prefer a <p> that's not the title.
                    let description = null;
                    let bestLen = 0;
                    for (const p of body.querySelectorAll('p')) {
                        if (p === titleEl) continue;
                        if (p.classList && p.classList.contains('accordion-button-icon')) continue;
                        const t = stripHtml(p.textContent);
                        if (!t) continue;
                        if (t.length > bestLen) { bestLen = t.length; description = t; }
                    }

                    // Tags: scan for short label-like list items in the body
                    // (e.g. "Experience: 2+ yrs", "Full Time", "Onsite").
                    const tags = [];
                    const bodyTxt = body.textContent || '';
                    const expM = bodyTxt.match(/(\d+\+?\s*(?:years?|yrs?))/i);
                    if (expM) tags.push(expM[1]);
                    const typeM = bodyTxt.match(/\b(Full[-\s]?Time|Part[-\s]?Time|Contract|Internship)\b/i);
                    if (typeM) tags.push(typeM[1]);
                    const modeM = bodyTxt.match(/\b(On-?site|Remote|Hybrid)\b/i);
                    if (modeM) tags.push(modeM[1]);
                    if (openings) tags.push(`${openings} openings`);

                    const attendanceMode = (() => {
                        const m = (modeM && modeM[1] ? modeM[1] : '').toLowerCase();
                        if (m.includes('remote')) return 'online';
                        if (m.includes('hybrid')) return 'hybrid';
                        if (m) return 'in-person';
                        return null;
                    })();

                    // Role-specific apply link if present, else the shared form.
                    const roleApply = card.querySelector(
                        'a[href*="/career/job-apply"], a[href*="apply"], a[href*="career/"]'
                    );
                    let registrationUrl = applyUrl;
                    if (roleApply) {
                        const raw = roleApply.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:)/i.test(raw)) {
                            try { registrationUrl = new URL(raw, window.location.origin).href; }
                            catch (e) { /* keep default */ }
                        }
                    }

                    const imgEl = card.querySelector('img');
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `esignature-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'E-Signature Pvt. Ltd.',
                        category: null,
                        tags,
                        image,
                        url: entryUrl,
                        registrationUrl,
                        attendanceMode,
                        source: 'esignature',
                    });
                } catch (err) {
                    // ignore per-card failures
                }
            }
            return out;
        }, ESIGNATURE_CAREERS_URL, ESIGNATURE_APPLY_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[esignature] no open roles found - returning empty list');
        } else {
            console.log(`? [esignature] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};