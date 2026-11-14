// src/scrapers/extractors/jobs/progressivelabs.js
// Site-specific extractor for progressivelabs.tech/vacancy/.
// See ../README.md for the contract.
//
// CONFIRMED FROM EVIDENCE:
//   - This IS the real job listing page (title "Job Openings & Careers |
//     Progressive Labs"; body opens "Available Positions / Search / ...
//     Business Development Representative / In Office (Kathmandu, Nepal)
//     / Apply / Product Engineer / Hybrid (Kathmandu, Nepal) / Apply /
//     Digital Marketing Specialist / In Office (Kathmandu, Nepal) /
//     Apply / Software Engineer (JavaSc.").
//   - Cards are INLINE (single-page-cards), no per-job detail hrefs.
//     detailLinkCandidates are all /services/* or /career/ marketing
//     routes; anchorGroups show no /job/, /vacancy/<slug>, /apply/ URLs.
//   - Each role card has the pattern:
//        <h?>Title</h?>
//        In Office (Kathmandu, Nepal)  | Hybrid (.) | Remote (.)
//        Apply  (link/button)
//   - The site is an Elementor/WordPress build. No JobPosting JSON-LD
//     exists (only Organization/WebSite/WebPage/Article/Person).
//
// Strategy (single-page):
//   1. Anchor on the "Available Positions" heading, get its containing
//      section so we never scan nav / footer / services pages.
//   2. Within that section, locate each Apply control (link/button) and
//      climb up to a card-sized container that also holds the role
//      heading and the mode/location line.
//   3. Parse "In Office / Hybrid / Remote (City, Country)" into
//      attendanceMode + location.
//   4. registrationUrl = the Apply control's href (or mailto). url stays
//      the listing page since there is no per-role detail URL.
//   5. Return [] gracefully if no Apply controls are found.
//
// Do not invent selectors beyond the evidence-based card pattern
// (title  "Mode (Location)"  Apply); everything else is defensive.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const PL_VACANCY_URL = 'https://progressivelabs.tech/vacancy/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [progressivelabs] Scraping Progressive Labs vacancies...');

        meta.pagesVisited++;
        await page.goto(PL_VACANCY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000); // Elementor + any lazy section hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [progressivelabs] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll through so any lazily revealed cards mount.
        try {
            const h = await page.evaluate(() => document.body.scrollHeight);
            const steps = Math.min(8, Math.ceil(h / 800));
            for (let i = 0; i < steps; i++) {
                await page.evaluate((y) => window.scrollTo(0, y), i * 800);
                await delay(250);
            }
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(800);
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

            // Mode+location regex: "In Office (Kathmandu, Nepal)",
            // "Hybrid (Kathmandu, Nepal)", "Remote (.)" - case insensitive.
            const modeLocRe = /\b(In[-\s]?Office|On-?site|Onsite|Hybrid|Remote)\s*\(\s*([^)]+?)\s*\)/i;

            // ---- 1) Locate the "Available Positions" section ----
            let section = null;
            for (const el of document.querySelectorAll('h1, h2, h3, h4')) {
                if (el.closest('nav, header, footer')) continue;
                if (/available positions?/i.test((el.textContent || '').trim())) {
                    // Climb to a container that has more than just this heading.
                    let container = el.parentElement;
                    for (let i = 0; i < 5 && container && container !== document.body; i++) {
                        if (container.querySelectorAll('h2, h3, h4').length > 1 ||
                            container.textContent.length > 400) {
                            section = container;
                            break;
                        }
                        container = container.parentElement;
                    }
                    if (section) break;
                }
            }

            // Fallback: whole page if we can't isolate the section.
            const scope = section || document.body;

            // ---- 2) Find every Apply control in scope ----
            const applyRe = /^apply( now)?$/i;
            const controls = Array.from(scope.querySelectorAll('a, button'))
                .filter((el) => {
                    if (el.closest('nav, header, footer')) return false;
                    const t = clean(el.textContent) || '';
                    return applyRe.test(t);
                });

            for (const ctrl of controls) {
                try {
                    // Climb to a card-sized ancestor that contains:
                    //   - a heading (title)
                    //   - a "Mode (Location)" string
                    //   - the apply control itself
                    let card = ctrl.parentElement;
                    let title = null;
                    let modeLocMatch = null;

                    for (let i = 0; i < 7 && card && card !== document.body; i++) {
                        // Title candidate: first heading inside card.
                        const headingEl = card.querySelector('h2, h3, h4, h5');
                        const headingTxt = headingEl ? clean(headingEl.textContent) : null;

                        // Mode/Location candidate: from card text.
                        const cardTxt = card.textContent || '';
                        const m = cardTxt.match(modeLocRe);

                        if (headingTxt && headingTxt.length >= 3 && headingTxt.length <= 140 && m) {
                            title = headingTxt;
                            modeLocMatch = m;
                            break;
                        }
                        card = card.parentElement;
                    }

                    if (!title || !modeLocMatch) continue;

                    // Reject headings that are clearly the section marker.
                    if (/^(available positions?|search)$/i.test(title)) continue;

                    // Dedupe by title.
                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const rawMode = modeLocMatch[1].toLowerCase();
                    const locationTxt = clean(modeLocMatch[2]) || null;

                    let attendanceMode = null;
                    if (/remote/.test(rawMode)) attendanceMode = 'online';
                    else if (/hybrid/.test(rawMode)) attendanceMode = 'hybrid';
                    else if (/in[-\s]?office|on-?site|onsite/.test(rawMode)) attendanceMode = 'in-person';

                    // Description: first meaningful <p> inside the card, if any.
                    let description = null;
                    if (card) {
                        for (const p of card.querySelectorAll('p')) {
                            const t = stripHtml(p.textContent);
                            if (!t) continue;
                            if (/^(apply( now)?|in[-\s]?office|hybrid|remote)/i.test(t)) continue;
                            if (t.length < 30) continue;
                            description = t;
                            break;
                        }
                    }

                    // Apply URL: prefer href of the control.
                    let registrationUrl = null;
                    if (ctrl.tagName === 'A') {
                        const raw = ctrl.getAttribute('href') || '';
                        if (raw && !/^(tel:|javascript:)/i.test(raw) && !/^#/.test(raw)) {
                            if (/^mailto:/i.test(raw)) registrationUrl = raw;
                            else {
                                const resolved = abs(raw);
                                if (resolved) registrationUrl = resolved;
                            }
                        }
                    }

                    out.push({
                        id: `progressivelabs-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: locationTxt,
                        price: null,
                        organizer: 'Progressive Labs',
                        category: null,
                        tags: [],
                        image: null,
                        // No per-role detail page - canonical URL is the
                        // vacancy listing; apply link goes in registrationUrl.
                        url: entryUrl,
                        registrationUrl: registrationUrl || entryUrl,
                        attendanceMode,
                        source: 'progressivelabs',
                    });
                } catch (e) {
                    // skip malformed card
                }
            }

            return out;
        }, PL_VACANCY_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[progressivelabs] no open roles found - returning empty list');
        } else {
            console.log(`? [progressivelabs] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};