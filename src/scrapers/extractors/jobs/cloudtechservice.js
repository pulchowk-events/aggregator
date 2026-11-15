// src/scrapers/extractors/jobs/cloudtechservice.js
// Site: https://cloudtechservice.com/careers/
// Verdict: CAREERS_PAGE (structurally the careers/listing page), but as of
// this dump the page explicitly states "There are no open positions right
// now" - the extractor must return [] cleanly in that state.
//
// Corrections to the wizard's assumptions:
//   - "Detail-link pattern /services (7 matches)" was a FALSE POSITIVE: those
//     are service-page anchors (services#sv-panel-*), not job detail pages.
//     detailLinkCandidates was empty - the site has no per-job URLs.
//   - "Card wrapper: path" is SVG chrome, not cards.
//   - Openings live in an on-page section (#cr-positions) as inline cards.
//     When openings exist the cards carry title + meta inline (no detail page),
//     so this is effectively single-page-cards, not listing-to-detail.
//
// Selector drift history:
//   2026-11-15: initial extraction. #cr-positions anchor confirmed in
//                nav ("View Open Positions" -> /#cr-positions). Benefit /
//                office cards confirmed as .cr-benefit-card / .cr-office-card
//                (NOT jobs - do not collect those).

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CTS_URL = 'https://cloudtechservice.com/careers/';
const CTS_COMPANY = 'CloudTech Services';

// Sections that are definitely NOT jobs (benefits, offices, services nav).
const NON_JOB_CLASS_RE = /(cr-benefit-card|cr-office-card|sv-accordion-item|accordion-item|footer|navbar|nav-link)/i;

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, CTS_URL);
            await delay(Math.random() * 800 + 400);
        } catch (err) {
            console.warn(`?? [cloudtechservice] failed to load careers page: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [cloudtechservice] page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('#cr-positions, h2', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // Site publishes its empty state in plain text on the page - trust it.
        const emptyState = await page.evaluate(() => {
            const root = document.querySelector('#cr-positions')
                || Array.from(document.querySelectorAll('h2')).find((h) => /open positions/i.test(h.textContent || ''))
                || document.body;
            const text = (root && root.innerText ? root.innerText : '').toLowerCase();
            return /no open positions|no current openings|no vacancies|there are no open/.test(text);
        });

        if (emptyState) {
            meta.listingHits = 0;
            console.log('  [cloudtechservice] extracted 0 (site reports no open positions)');
            return { items, meta };
        }

        // Harvest job-like cards inside #cr-positions (or fallback containers).
        // No per-job detail pages exist, so the card IS the record.
        const cards = await page.evaluate((nonJobReStr) => {
            const nonJobRe = new RegExp(nonJobReStr, 'i');
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            const scopes = [];
            const posSection = document.querySelector('#cr-positions');
            if (posSection) scopes.push(posSection);
            // Fallback: everything after the "Open Positions" heading.
            if (scopes.length === 0) {
                const h = Array.from(document.querySelectorAll('h1, h2, h3'))
                    .find((el) => /open positions/i.test(el.textContent || ''));
                if (h && h.parentElement) scopes.push(h.parentElement);
            }

            const out = [];
            const seen = new Set();

            const isJunk = (el) => {
                if (!el) return true;
                if (el.closest && el.closest('header, footer, nav')) return true;
                const cls = el.className && typeof el.className === 'string' ? el.className : '';
                if (nonJobRe.test(cls)) return true;
                return false;
            };

            for (const scope of scopes) {
                if (!scope) continue;

                // Candidate job-card containers - common positional class hints
                // only (no invented site-specific class names).
                const candidates = Array.from(scope.querySelectorAll(
                    '[class*="position"], [class*="job"], [class*="vacancy"], article, li'
                ));

                for (const el of candidates) {
                    if (isJunk(el)) continue;
                    if (el.children.length > 40) continue;

                    const heading = el.querySelector('h1, h2, h3, h4, h5');
                    const title = clean(heading ? heading.textContent : null);
                    if (!title || title.length < 3 || title.length > 160) continue;
                    if (/^(open positions|current opportunities|join our team|drop your cv|our workstations|designed to help you thrive|book a call)$/i.test(title)) continue;

                    const text = clean(el.innerText);
                    if (!text) continue;

                    // Require a job-ish signal so we don't collect benefit blurbs.
                    const jobish = /(full[- ]?time|part[- ]?time|contract|intern(ship)?|remote|onsite|on-site|hybrid|experience|deadline|apply|vacanc|positions?\b|engineer|developer|designer|analyst|manager|intern)/i.test(text);
                    if (!jobish) continue;

                    const applyA = el.querySelector('a[href]');
                    let applyUrl = null;
                    if (applyA) {
                        try { applyUrl = applyA.href; } catch (_) { /* ignore */ }
                    }

                    const imgEl = el.querySelector('img');
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    const key = title + '|' + text.slice(0, 120);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    out.push({ title, text, applyUrl, image });
                }
            }

            return out;
        }, NON_JOB_CLASS_RE.source);

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            console.log('  [cloudtechservice] extracted 0');
            return { items, meta };
        }

        // Site-wide office addresses (used only when per-card location is absent).
        let siteLocation = null;
        try {
            siteLocation = await page.evaluate(() => {
                const p = document.querySelector('[class*="address"]');
                return p ? p.textContent.replace(/\s+/g, ' ').trim() : null;
            });
        } catch (e) { /* ignore */ }

        for (const card of cards) {
            try {
                const text = card.text || '';

                const employment = text.match(/\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary|Freelance)\b/i);
                const mode = text.match(/\b(Remote|On-?site|Hybrid)\b/i);
                const deadline = text.match(/Deadline\s*[:\-]?\s*([^\n|]+)/i);
                const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
                const experience = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\s*\+)?)/i);
                const level = text.match(/\b(Junior|Mid[- ]?Level|Senior|Lead|Principal|Entry[- ]?Level)\b/i);

                // Per-card location: look for the word "location" or a city/area
                // fragment inside the card; fall back to first site address.
                let location = null;
                const locMatch = text.match(/Location\s*[:\-]?\s*([^|\n]{2,60})/i);
                if (locMatch) location = locMatch[1].trim();
                if (!location) location = siteLocation;

                items.push({
                    id: `cloudtechservice-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: card.title,
                    company: CTS_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name "CloudTech Services" and page chrome',
                    description: text || null,
                    description_status: text ? 'extracted' : 'extraction_failed',
                    description_evidence: text
                        ? 'inline opening card text (no per-job detail page exists on this site)'
                        : 'card text empty',
                    date: null,
                    time: null,
                    location: location || null,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: location
                        ? (locMatch ? 'Location: . inside opening card' : '[class*="address"] site office block')
                        : 'no location text in card and no [class*="address"] element',
                    price: null,
                    organizer: CTS_COMPANY,
                    category: null,
                    tags: [employment ? employment[1] : null, mode ? mode[1] : null, level ? level[1] : null].filter(Boolean),
                    image: card.image || null,
                    image_status: card.image ? 'extracted' : 'site_absent',
                    image_evidence: card.image
                        ? 'first img element inside opening card'
                        : 'no img element inside opening card',
                    url: card.applyUrl || CTS_URL,
                    registrationUrl: card.applyUrl || CTS_URL,
                    attendanceMode: mode ? mode[1].toLowerCase().replace(/-/g, '') : null,
                    source: 'cloudtechservice',
                    employmentType: employment ? employment[1].replace(/\s+/g, ' ') : null,
                    employmentType_status: employment ? 'extracted' : 'site_absent',
                    employmentType_evidence: employment
                        ? 'Full/Part/Contract/Internship token in card text'
                        : 'no employment-type token found in card text',
                    applicationEndsRaw: deadline ? deadline[1].trim() : null,
                    applicationEnds_status: deadline ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: deadline
                        ? 'Deadline: . inside card text'
                        : 'no Deadline: line in card text',
                    salary: salary ? salary[1].trim() : null,
                    salary_status: salary ? 'extracted' : 'site_absent',
                    salary_evidence: salary
                        ? 'salary/compensation string in card text'
                        : 'no salary/compensation text in card',
                    experience: experience ? experience[1].trim() : null,
                    level: level ? level[1].replace(/\s+/g, ' ') : null
                });
            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [cloudtechservice] extracted ${items.length}`);
        return { items, meta };
    }
};