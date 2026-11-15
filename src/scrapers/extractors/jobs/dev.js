// src/scrapers/extractors/jobs/dev.js
// Site: https://dev.programiz.com/careers/content-writer-intern
// Verdict: CAREERS_PAGE (single job posting page - not a listing).
//
// Corrections to the wizard's assumptions:
//   - "listing-to-detail with /python-programming detail links" was a FALSE
//     POSITIVE. Those are site-navigation links to tutorials/compilers, not
//     job detail pages. There is no careers listing on this host - the entry
//     URL is a single job posting.
//   - "Card wrapper: script" is analytics chrome.
//   - "Detail title element H1.title-section__title" is from a *different*
//     page (python-programming tutorial); the actual posting title is the
//     h1 on this URL: "Programiz is hiring Programming Content Writer Interns!".
//   - This is a dev/staging host (dev.programiz.com). We still extract the
//     single posting as-is; the public canonical is likely programiz.com/careers/.,
//     which the orchestrator/verify layer can normalize later.
//
// Traversal strategy: single-page-item. One page, one item, one page.evaluate.
//
// Selector drift history:
//   2026-11-15: initial extraction. Description selectors are heuristic
//                (largest leaf-ish prose block inside <main>) because the
//                wizard's per-field scan only returned site-chrome text.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const DEV_URL = 'https://dev.programiz.com/careers/content-writer-intern';
const DEV_COMPANY = 'Programiz';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, DEV_URL);
            await delay(Math.random() * 800 + 400);
        } catch (err) {
            console.warn(`?? [dev] failed to load posting: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [dev] posting looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('h1, main, article', { timeout: 10000 });
        } catch (e) { /* continue */ }

        const record = await page.evaluate(() => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            // --- Title: prefer the h1 that looks like the posting ---
            let title = null;
            const h1s = Array.from(document.querySelectorAll('h1'));
            const postingH1 = h1s.find((h) => /hiring|we.re hiring|join|intern|writer|engineer|developer|designer|analyst|manager/i.test(h.textContent || ''));
            title = clean((postingH1 || h1s[0]) ? (postingH1 || h1s[0]).textContent : null);

            // --- Description: largest leaf-ish prose block inside <main>,
            // excluding site nav / footer / sidebar chrome. ---
            const root = document.querySelector('main, article, [role="main"]') || document.body;
            let descEl = null;
            let bestLen = 0;
            const candidates = Array.from(root.querySelectorAll('section, article, div, td'));
            for (const el of candidates) {
                if (el.closest('header, footer, nav, aside, form.search, .footer__columns')) continue;
                const txt = clean(el.innerText) || '';
                const len = txt.length;
                if (len < 300) continue;
                // Skip page-level wrappers whose parent is basically the same size.
                const parentLen = el.parentElement ? (clean(el.parentElement.innerText) || '').length : 0;
                if (parentLen > len * 0.95) continue;
                // Skip blocks dominated by nav link text.
                const linkCount = el.querySelectorAll('a').length;
                if (linkCount > 25 && len / Math.max(linkCount, 1) < 60) continue;
                if (len > bestLen) {
                    bestLen = len;
                    descEl = el;
                }
            }
            const description = descEl ? clean(descEl.innerText) : null;

            const bodyText = clean(document.body ? document.body.innerText : '') || '';

            // --- Apply CTA: first non-nav mailto or "Apply" link on page ---
            let applyUrl = null;
            const mailto = Array.from(document.querySelectorAll('a[href^="mailto:"]')).find((a) => /career|jobs?|hiring|apply/i.test(a.href || ''));
            if (mailto) {
                applyUrl = mailto.href;
            } else {
                const applyA = Array.from(document.querySelectorAll('a[href]')).find((a) => {
                    if (a.closest('header, footer, nav')) return false;
                    const t = (a.textContent || '').trim().toLowerCase();
                    const h = (a.getAttribute('href') || '').toLowerCase();
                    if (h.startsWith('javascript:')) return false;
                    return /apply|submit|careers?@|jobs?@/.test(t) || /apply/.test(h);
                });
                if (applyA) {
                    try { applyUrl = applyA.href; } catch (_) { /* ignore */ }
                }
            }

            // --- Image: first meaningful img in main (skip logos/icons) ---
            let image = null;
            const imgEl = Array.from(root.querySelectorAll('img')).find((img) => {
                if (img.closest('header, footer, nav')) return false;
                const w = img.naturalWidth || img.width || 0;
                const h = img.naturalHeight || img.height || 0;
                if ((w && w < 80) || (h && h < 80)) return false;
                const src = img.getAttribute('src') || '';
                if (/logo|icon|sprite/i.test(src)) return false;
                return true;
            });
            if (imgEl) {
                try { image = window.__resolveImageSrc(imgEl); } catch (_) { /* ignore */ }
            }

            return {
                title,
                description,
                bodyText,
                applyUrl,
                image,
                finalUrl: window.location.href
            };
        });

        safeDiscovered(progress, 1);
        meta.listingHits = 1;

        try {
            const text = `${record.title || ''}\n${record.bodyText || ''}`;

            const employment = text.match(/\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Intern|Trainee)\b/i);
            const mode = text.match(/\b(Remote|On-?site|Hybrid)\b/i);
            const location = (() => {
                const m = text.match(/(?:Location|Based in|Office)\s*[:\-]?\s*([^\n|]{2,60})/i);
                if (m) return m[1].trim();
                const m2 = text.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote)\b/i);
                return m2 ? m2[1] : null;
            })();
            const deadline = text.match(/(?:Deadline|Apply by|Apply before|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
            const salary = text.match(/(?:Salary|Compensation|Stipend|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
            const experience = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\s*\+)?)/i);

            if (!record.title) {
                meta.detailParseFailures++;
                console.log('  [dev] extracted 0 (no title)');
                return { items, meta };
            }

            items.push({
                id: `dev-${record.finalUrl.split('/').filter(Boolean).pop() || 'posting'}`,
                title: record.title,
                company: DEV_COMPANY,
                company_status: 'extracted',
                company_evidence: 'og:site_name "Programiz"; host dev.programiz.com; posting title names Programiz',
                description: record.description,
                description_status: record.description ? 'extracted' : 'extraction_failed',
                description_evidence: record.description
                    ? 'largest leaf-ish prose block inside main/article excluding header/footer/nav (heuristic; wizard per-field scan on this page returned only site chrome)'
                    : 'tried section/article/div/td inside main; no block >300 chars outside chrome',
                date: null,
                time: null,
                location: location || null,
                location_status: location ? 'extracted' : 'site_absent',
                location_evidence: location
                    ? 'Location label or Nepal/Kathmandu/Remote token in page text'
                    : 'no Location label and no city/remote token found in page text',
                price: null,
                organizer: DEV_COMPANY,
                category: null,
                tags: [employment ? employment[1] : null, mode ? mode[1] : null].filter(Boolean),
                image: record.image || null,
                image_status: record.image ? 'extracted' : 'site_absent',
                image_evidence: record.image
                    ? 'first meaningful img in main (>=80px, not logo/icon)'
                    : 'no img >=80px in main that is not a logo/icon',
                url: record.finalUrl,
                registrationUrl: record.applyUrl || record.finalUrl,
                attendanceMode: mode ? mode[1].toLowerCase().replace(/-/g, '') : null,
                source: 'dev',
                employmentType: employment ? employment[1].replace(/\s+/g, ' ') : null,
                employmentType_status: employment ? 'extracted' : 'site_absent',
                employmentType_evidence: employment
                    ? 'Full/Part/Contract/Internship token in page text'
                    : 'no employment-type token found in page text',
                applicationEndsRaw: deadline ? deadline[1].trim() : null,
                applicationEnds_status: deadline ? 'extracted' : 'site_absent',
                applicationEnds_evidence: deadline
                    ? 'Deadline/Apply by label in page text'
                    : 'no Deadline/Apply by label in page text',
                salary: salary ? salary[1].trim() : null,
                salary_status: salary ? 'extracted' : 'site_absent',
                salary_evidence: salary
                    ? 'salary/stipend/NPR string in page text'
                    : 'no salary/stipend/NPR string in page text',
                experience: experience ? experience[1].trim() : null
            });
        } catch (err) {
            meta.detailParseFailures++;
            console.warn(`?? [dev] item parse failed: ${err.message}`);
        } finally {
            safeUnitDone(progress);
        }

        console.log(`  [dev] extracted ${items.length}`);
        return { items, meta };
    }
};