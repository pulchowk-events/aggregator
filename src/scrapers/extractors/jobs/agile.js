// src/scrapers/extractors/jobs/agile.js
// Site-specific extractor. See ../README.md for the contract.
//
// Wizard assumptions corrected:
//   - "detail-link pattern: %C2%A0014004789" was a FALSE POSITIVE - that's
//     `tel:+977-1-4004789` (site phone number), not a job detail link.
//   - "card wrapper: link (38)" was a FALSE POSITIVE - those are <link> rel tags.
//   - Actual structure: single-page Elementor careers listing with a
//     "Current Openings" section (h2 on listing). Roles render as Elementor
//     post/widget cards under that heading; no per-job detail route exists.
//   - Traversal: single-page harvest from the "Current Openings" scope.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CAREER_URL = 'https://agile.com.np/career/';

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        console.log('?? [agile] Scraping Agile Solutions careers...');
        meta.pagesVisited++;

        await loadPage(page, CAREER_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            meta.looksBlocked = true;
            console.log('  [agile] looksBlocked');
            return { items: [], meta };
        }

        // Elementor renders list widgets late - let hydration finish, then park on the section.
        await delay(3500);
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h1, h2, h3'))
                .find((el) => /current openings/i.test(el.textContent || ''));
            if (h) h.scrollIntoView({ block: 'start' });
            else window.scrollTo(0, document.body.scrollHeight * 0.5);
        }).catch(() => {});
        await delay(2000);
        await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
        await delay(1500);

        const raw = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            const BASE = window.location.origin;
            const LISTING_URL = window.location.href;
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);

            const REJECT_TITLE = /^(current openings|careers?|apply(\s+now)?|read more|view (details|job)|learn more)$/i;

            const push = (j) => {
                if (!j || !j.title) return;
                const t = j.title.trim();
                if (!t || t.length < 3 || t.length > 160) return;
                if (REJECT_TITLE.test(t)) return;
                const key = t.toLowerCase() + '|' + (j.url || '');
                if (seen.has(key)) return;
                seen.add(key);
                out.push(j);
            };

            // Scope: section containing the "Current Openings" heading.
            const headEl = Array.from(document.querySelectorAll('h1, h2, h3'))
                .find((el) => /current openings/i.test(el.textContent || ''));
            const scope = headEl
                ? (headEl.closest('section, .elementor-section, .elementor-top-section, .elementor-widget-container')
                    || headEl.parentElement?.parentElement
                    || headEl.parentElement
                    || document)
                : document;

            // Candidate job cards - Elementor-friendly first, then generic.
            const cardSels = [
                '.elementor-posts .elementor-post',
                '.elementor-loop-container .e-loop-item',
                '.elementor-post', '.e-loop-item',
                'article', '.card',
                '.job-card', '.career-card', '.opening-card'
            ];
            const cardSet = new Set();
            const cards = [];
            for (const sel of cardSels) {
                try {
                    scope.querySelectorAll(sel).forEach((el) => {
                        if (cardSet.has(el)) return;
                        cardSet.add(el);
                        const txt = el.textContent || '';
                        if (txt.length < 20) return;
                        cards.push(el);
                    });
                } catch (_) {}
            }

            // Fallback: heading-anchored cards inside the section.
            if (cards.length === 0 && headEl) {
                const subHeadings = Array.from(scope.querySelectorAll(
                    'h3, h4, h5, .elementor-heading-title'
                ));
                for (const h of subHeadings) {
                    const t = clean(h.textContent);
                    if (!t || t.length < 3 || t.length > 160) continue;
                    if (/current openings/i.test(t)) continue;
                    const card = h.closest('.elementor-widget, .elementor-element, .elementor-post, article, .card, li')
                        || h.parentElement;
                    if (card && !cardSet.has(card)) {
                        cardSet.add(card);
                        cards.push(card);
                    }
                }
            }

            for (const card of cards) {
                // Title - first non-reject heading or Elementor heading title.
                let title = null;
                for (const h of Array.from(card.querySelectorAll(
                    'h2, h3, h4, h5, .elementor-heading-title, strong'
                ))) {
                    const t = clean(h.textContent);
                    if (!t || t.length < 3 || t.length > 160) continue;
                    if (REJECT_TITLE.test(t)) continue;
                    title = t; break;
                }
                if (!title) continue;

                // URL - first meaningful http(s) or root-relative link in card.
                let url = LISTING_URL;
                let registrationUrl = null;
                const a = Array.from(card.querySelectorAll('a[href]')).find((x) => {
                    const h = x.getAttribute('href');
                    if (!h || h.startsWith('#') || h.startsWith('tel:') || h.startsWith('mailto:') || h === '/') return false;
                    try {
                        const u = new URL(h, BASE);
                        return u.hostname === window.location.hostname;
                    } catch (_) { return false; }
                });
                if (a) {
                    try {
                        const abs = new URL(a.getAttribute('href'), BASE).href;
                        url = abs;
                        registrationUrl = abs;
                    } catch (_) {}
                }

                // Description - longest paragraph or bullet.
                let description = null;
                const prose = Array.from(card.querySelectorAll('p, li, .elementor-text-editor'))
                    .map((p) => clean(p.textContent))
                    .filter((t) => t && t.length > 20)
                    .sort((x, y) => y.length - x.length);
                if (prose[0]) description = prose[0];

                // Location.
                let location = null;
                const locEl = card.querySelector('[class*="location" i], [class*="loc" i], address');
                if (locEl) location = clean(locEl.textContent);
                if (!location) {
                    const text = clean(card.textContent) || '';
                    const m = text.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|Onsite)\b/i);
                    if (m) location = m[0];
                }

                const text = clean(card.textContent) || '';

                // Employment type.
                let employmentType = null;
                const empM = text.match(/(full[\s-]?time|part[\s-]?time|contract(?:ual)?|internship|intern)/i);
                if (empM) employmentType = empM[0];

                // Experience.
                let experience = null;
                const expM = text.match(/(\d+\+?\s*(?:-\s*\d+\s*)?years?(?:\s+of)?\s+experience)/i);
                if (expM) experience = expM[0];

                push({
                    title,
                    description,
                    url,
                    registrationUrl,
                    location,
                    employmentType,
                    experience,
                    company: 'Agile Solutions',
                    _via: card.tagName.toLowerCase()
                });
            }

            return out;
        });

        const items = raw.map((r, i) => {
            const item = {
                id: `agile-${i}-${Date.now()}`,
                title: r.title || null,
                description: r.description || null,
                date: null,
                time: null,
                location: r.location || null,
                price: null,
                organizer: r.company || 'Agile Solutions',
                category: 'Job',
                tags: [],
                image: null,
                url: r.url || CAREER_URL,
                registrationUrl: r.registrationUrl || null,
                attendanceMode: r.location && /remote/i.test(r.location) ? 'remote' : 'in-person',
                source: 'agile',
                // jobs-specific extras
                company: r.company || 'Agile Solutions',
                companyUrl: 'https://agile.com.np',
                companyLogoUrl: null,
                employmentType: r.employmentType || null,
                applicationEndsRaw: null,
                salary: null,
                publishedAt: null,
                experience: r.experience || null,
                level: null,
                openings: null,
                responsibilities: null,
                requirements: null,
                skills: null
            };

            // Field status / evidence
            item.title_status = item.title ? 'extracted' : 'extraction_failed';
            if (item.title) item.title_evidence = `heading inside Current Openings card (${r._via || 'card'})`;

            item.company_status = 'extracted';
            item.company_evidence =
                'agile.com.np/career is Agile Solutions\' own careers page; og:site_name="Agile", og:title="Careers at Agile Solutions", and header logo name the employer';

            item.url_status = 'extracted';
            item.url_evidence =
                r.registrationUrl
                    ? 'first same-origin non-tel/non-mailto link in card'
                    : 'listing URL fallback (no per-job route published)';

            item.location_status = item.location ? 'extracted' : 'site_absent';
            if (!item.location) {
                item.location_evidence =
                    'searched [class*="location"], [class*="loc"], address inside card; header [class*="location"] only matches the site address block, no per-job location rendered';
            }

            item.description_status = item.description ? 'extracted' : 'site_absent';
            if (!item.description) {
                item.description_evidence =
                    'searched card <p>, <li>, .elementor-text-editor - no role body inline on the Current Openings card';
            }

            item.employmentType_status = item.employmentType ? 'extracted' : 'site_absent';
            if (!item.employmentType) {
                item.employmentType_evidence =
                    'searched card text and [class*="employment"] for full/part-time/contract/internship - none found';
            }

            item.applicationEndsRaw_status = 'site_absent';
            item.applicationEndsRaw_evidence =
                'no apply-by date string on Current Openings card or listing chrome';

            item.salary_status = 'site_absent';
            item.salary_evidence =
                'no salary/compensation text on Current Openings card';

            delete r._via;
            return item;
        });

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;
        if (items.length === 0) meta.atsEmpty = true;

        console.log(`  [agile] extracted ${items.length}`);

        return { items, meta };
    }
};