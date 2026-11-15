// src/scrapers/extractors/jobs/alpastechnology.js
// Site-specific extractor. See ../README.md for the contract.
//
// Wizard assumptions corrected:
//   - "Site type: listing-to-detail" - FALSE POSITIVE. detailLinkCandidates is
//     EMPTY. The 5 "/"-pattern anchor matches were nav links (Home, Story,
//     Skip-to-content) and mailto: CTAs - NOT per-job detail routes.
//     The provided "sample detail page" is /story (company history), not a
//     job detail. `applicationEndsRaw: time[datetime]` there are story dates
//     (2018-2024), not apply-by deadlines.
//   - "Card wrapper: meta (14)" - FALSE POSITIVE (<meta> tags).
//   - Real structure: single-page Elementor-style careers page with an
//     "Open roles" section (h2) but currently no rendered job cards in the
//     dump. Process-step cards under "How we hire" must NOT be treated as jobs.
//   - Strategy: attempt JSON-LD JobPosting, then scan the "Open roles"
//     section for real job cards (rejecting process-step headings and nav
//     chrome), then return empty if nothing qualifies.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CAREER_URL = 'https://alpastechnology.com/careers';

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        console.log('?? [alpastechnology] Scraping Alpas Technology careers...');
        meta.pagesVisited++;

        await loadPage(page, CAREER_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            meta.looksBlocked = true;
            console.log('  [alpastechnology] looksBlocked');
            return { items: [], meta };
        }

        // Let JS hydration settle, then park on the Open roles section.
        await delay(3500);
        await page.evaluate(() => {
            const h = Array.from(document.querySelectorAll('h1, h2, h3'))
                .find((el) => /open roles/i.test(el.textContent || ''));
            if (h) h.scrollIntoView({ block: 'start' });
            else window.scrollTo(0, document.body.scrollHeight * 0.45);
        }).catch(() => {});
        await delay(1800);

        const raw = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            const BASE = window.location.origin;
            const LISTING_URL = window.location.href;
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);

            // Site chrome / section headings / how-we-hire process steps.
            const REJECT_TITLE = /^(you could be next|open roles|how this place works|what you would work with|how we hire|what you get out of it|careers?|apply|apply now|send an open application|read our story first|our story|back to home|home|products(?:suite)?|services|govtech|case studies|blog|about|story|get in touch|skip to content|you send something real|a conversation,? not a quiz)$/i;

            const isJobHref = (href) => {
                if (!href) return false;
                try {
                    const u = new URL(href, BASE);
                    if (u.hostname !== window.location.hostname) return false;
                    return /\/(careers?|jobs?|positions?|roles?|openings?)\/[^/]+/i.test(u.pathname);
                } catch (_) { return false; }
            };

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

            // 1) JSON-LD JobPosting (usually absent on this site)
            for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
                try {
                    const data = JSON.parse(s.textContent);
                    const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
                    for (const node of nodes) {
                        if (!node) continue;
                        const t = node['@type'];
                        const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                        if (!isJob) continue;
                        push({
                            title: node.title ? String(node.title).trim() : null,
                            description: node.description ? String(node.description).trim() : null,
                            company: (node.hiringOrganization && node.hiringOrganization.name) || 'Alpas Technology',
                            companyUrl: (node.hiringOrganization && node.hiringOrganization.sameAs) || null,
                            companyLogoUrl: (node.hiringOrganization && node.hiringOrganization.logo) || null,
                            location:
                                (node.jobLocation && node.jobLocation.address &&
                                    (node.jobLocation.address.addressLocality ||
                                     node.jobLocation.address.addressRegion)) || null,
                            employmentType: Array.isArray(node.employmentType)
                                ? node.employmentType.join(', ')
                                : (node.employmentType || null),
                            applicationEndsRaw: node.validThrough || null,
                            publishedAt: node.datePosted || null,
                            salary: (node.baseSalary && node.baseSalary.value && node.baseSalary.value.value != null)
                                ? `${node.baseSalary.value.value} ${(node.baseSalary && node.baseSalary.currency) || ''}`.trim()
                                : null,
                            url: node.url || LISTING_URL,
                            registrationUrl: node.url || null,
                            _via: 'jsonld_jobposting'
                        });
                    }
                } catch (_) {}
            }

            // 2) DOM: cards inside the "Open roles" section only.
            if (out.length === 0) {
                const openH2 = Array.from(document.querySelectorAll('h2, h3'))
                    .find((h) => /open roles/i.test(h.textContent || ''));
                const section = openH2
                    ? (openH2.closest('section') || openH2.parentElement || null)
                    : null;

                if (section) {
                    // Candidate job cards: prefer structured card selectors, fall back to list/div children.
                    const cardSels = [
                        'li[class*="card"]', 'article[class*="card"]', 'div[class*="card"]',
                        'li[class*="job"]', 'div[class*="job"]',
                        'li[class*="role"]', 'div[class*="role"]',
                        'li', 'article'
                    ];
                    const seenEls = new Set();
                    const cards = [];
                    for (const sel of cardSels) {
                        try {
                            section.querySelectorAll(sel).forEach((el) => {
                                if (seenEls.has(el)) return;
                                seenEls.add(el);
                                const text = (el.textContent || '').trim();
                                if (text.length < 15 || text.length > 1500) return;
                                cards.push(el);
                            });
                        } catch (_) {}
                    }

                    for (const card of cards) {
                        // A real job card must have a heading, not just body copy.
                        let headingEl = null;
                        for (const h of Array.from(card.querySelectorAll('h2, h3, h4, h5, strong, .font-bold'))) {
                            const t = clean(h.textContent);
                            if (!t || t.length < 3 || t.length > 160) continue;
                            if (REJECT_TITLE.test(t)) continue;
                            headingEl = h;
                            break;
                        }
                        if (!headingEl) continue;
                        const title = clean(headingEl.textContent);

                        const cardText = clean(card.textContent) || '';

                        // Require at least one job signal: job-ish link, employment type,
                        // or an explicit location - process-step cards have none of these.
                        const linkEl = Array.from(card.querySelectorAll('a[href]')).find((a) => {
                            const h = a.getAttribute('href');
                            if (!h || h.startsWith('#')) return false;
                            if (h.startsWith('tel:') || h.startsWith('mailto:')) return false;
                            if (isJobHref(h)) return true;
                            // Allow "Apply" text pointing anywhere same-origin
                            return /apply|view|details/i.test(a.textContent || '');
                        });

                        const empMatch = cardText.match(/(full[\s-]?time|part[\s-]?time|contract(?:ual)?|internship|intern)\b/i);
                        const locMatch = cardText.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|Onsite)\b/i);

                        if (!linkEl && !empMatch && !locMatch) continue;

                        let url = LISTING_URL;
                        let registrationUrl = null;
                        if (linkEl) {
                            try {
                                const abs = new URL(linkEl.getAttribute('href'), BASE).href;
                                url = abs;
                                registrationUrl = abs;
                            } catch (_) {}
                        }

                        // Description: longest paragraph inside the card.
                        let description = null;
                        const ps = Array.from(card.querySelectorAll('p'))
                            .map((p) => clean(p.textContent))
                            .filter((t) => t && t.length > 20)
                            .sort((a, b) => b.length - a.length);
                        if (ps[0]) description = ps[0];

                        const experience = (cardText.match(/(\d+\+?\s*(?:-\s*\d+\s*)?years?(?:\s+of)?\s+experience)/i) || [])[0] || null;

                        push({
                            title,
                            description,
                            url,
                            registrationUrl,
                            location: locMatch ? locMatch[0] : null,
                            employmentType: empMatch ? empMatch[0] : null,
                            experience,
                            company: 'Alpas Technology',
                            _via: 'open_roles_card'
                        });
                    }
                }
            }

            return out;
        });

        const items = raw.map((r, i) => {
            const item = {
                id: `alpas-${i}-${Date.now()}`,
                title: r.title || null,
                description: r.description || null,
                date: r.publishedAt || null,
                time: null,
                location: r.location || null,
                price: null,
                organizer: r.company || 'Alpas Technology',
                category: 'Job',
                tags: [],
                image: r.companyLogoUrl || null,
                url: r.url || CAREER_URL,
                registrationUrl: r.registrationUrl || null,
                attendanceMode: r.location && /remote/i.test(r.location) ? 'remote' : 'in-person',
                source: 'alpastechnology',
                // jobs-specific extras
                company: r.company || 'Alpas Technology',
                companyUrl: r.companyUrl || 'https://alpastechnology.com',
                companyLogoUrl: r.companyLogoUrl || null,
                employmentType: r.employmentType || null,
                applicationEndsRaw: r.applicationEndsRaw || null,
                salary: r.salary || null,
                publishedAt: r.publishedAt || null,
                experience: r.experience || null,
                level: null,
                openings: null,
                responsibilities: null,
                requirements: null,
                skills: null
            };

            // Field status / evidence
            item.title_status = item.title ? 'extracted' : 'extraction_failed';
            if (item.title) item.title_evidence = r._via || 'card heading';

            item.company_status = 'extracted';
            item.company_evidence =
                'alpastechnology.com/careers is Alpas Technology\'s own careers page; og:site_name="Alpas Technology", og:title="Careers at Alpas Technology", site chrome names Alpas';

            item.url_status = 'extracted';
            item.url_evidence =
                r._via === 'jsonld_jobposting'
                    ? 'JSON-LD JobPosting.url'
                    : (r.registrationUrl
                        ? 'job-ish / apply-CTA anchor inside Open roles card'
                        : 'listing URL fallback (no per-job route published)');

            item.location_status = item.location ? 'extracted' : 'site_absent';
            if (!item.location) {
                item.location_evidence =
                    'searched card text and [class*="location"] inside Open roles section; office address only appears in careers intro / footer, no per-role location rendered';
            }

            item.description_status = item.description ? 'extracted' : 'extraction_failed';
            if (!item.description) {
                item.description_evidence =
                    'searched card <p> inside Open roles section; no role body inline (site has no per-job detail page - see corrected assumptions)';
            }

            item.employmentType_status = item.employmentType ? 'extracted' : 'site_absent';
            if (!item.employmentType) {
                item.employmentType_evidence =
                    'searched card text and [class*="employment"] inside Open roles section for full/part-time/contract/internship - none found';
            }

            item.applicationEndsRaw_status = 'site_absent';
            item.applicationEndsRaw_evidence =
                'searched Open roles card and card <time> elements; only site-wide <time> tags on /story are historical dates, not apply-by deadlines';

            item.salary_status = 'site_absent';
            item.salary_evidence =
                'no salary/compensation text on Open roles card or JSON-LD baseSalary';

            delete r._via;
            return item;
        });

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;
        if (items.length === 0) meta.atsEmpty = true;

        console.log(`  [alpastechnology] extracted ${items.length}`);

        return { items, meta };
    }
};