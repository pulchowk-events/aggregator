// src/scrapers/extractors/jobs/sourcecode.js
// Site-specific extractor for sourcecode.com.np/join-us/.
// See ../README.md for the contract.
//
// NOTES ON THE EVIDENCE DUMP:
//   - The dump captured sourcecode.com.np/ - the HOMEPAGE - even though
//     the entry URL is /join-us/. The site is an Angular SPA (anchors
//     carry `routerlink` attributes), so client-side routing during the
//     dump resolved to the home route. This means we have NO evidence of
//     the actual /join-us/ DOM shape; we must extract defensively.
//   - The nav on the homepage contains a "Join Us" link pointing at the
//     careers route, which is what we're visiting. So the entry URL is
//     semantically correct.
//   - cardCandidates in the dump are product sections ("Smart Analytics
//     (SA)", "Smart Charts (SC)"), services blocks, and the footer - all
//     marketing, no roles.
//   - All detailLinkCandidates are /product/* marketing routes, NOT jobs.
//   - No JobPosting JSON-LD exists (only Organization / WebSite /
//     WebPage / CollectionPage).
//
// Strategy: extract defensively on /join-us/ only -
//   1) Wait for Angular hydration (longer settle, plus scroll + wait for
//      any role-list container).
//   2) Prefer JSON-LD JobPosting.
//   3) Accept real job-detail anchors, explicitly excluding /product/*,
//      /services, /aboutus, /contact - the site's known routes.
//   4) Role headings inside an "openings"/"vacancies"/"join our team"
//      block, with a strict exclusion list for product/service headings.
//   5) Return [] gracefully if there are no real roles - never emit
//      product cards or footer links as jobs.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const SOURCECODE_CAREERS_URL = 'https://sourcecode.com.np/join-us/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [sourcecode] Scraping Source Code join-us page...');

        meta.pagesVisited++;
        await page.goto(SOURCECODE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });

        // Angular SPA - give the router + components time to hydrate.
        await delay(3000);
        try {
            await page.evaluate(() => {
                const here = window.location.pathname.replace(/\/$/, '');
                if (!/\/join-us$/.test(here)) {
                    // Angular fell back to the home route; hard-navigate to
                    // the careers path via the in-app router link if present.
                    const link = Array.from(document.querySelectorAll('a[href]'))
                        .find((a) => /\/join-us(\/|$|\?|#)/i.test(a.getAttribute('href') || ''));
                    if (link) link.click();
                }
            });
            await delay(2000);
        } catch (e) { /* best-effort */ }

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [sourcecode] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll through the page to trigger lazy-loaded components.
        try {
            const h = await page.evaluate(() => document.body.scrollHeight);
            const steps = Math.min(8, Math.ceil(h / 800));
            for (let i = 0; i < steps; i++) {
                await page.evaluate((y) => window.scrollTo(0, y), i * 800);
                await delay(300);
            }
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(200);
        } catch (e) { /* best-effort */ }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };
            const clean = (s) => (s
                ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
                : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            // ---- 1) JSON-LD JobPosting ----
            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                let parsed;
                try { parsed = JSON.parse(s.textContent); }
                catch { continue; }
                const nodes = Array.isArray(parsed)
                    ? parsed
                    : (parsed && parsed['@graph']) || [parsed];
                for (const node of nodes) {
                    if (!node) continue;
                    const t = node['@type'];
                    const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                    if (!isJob) continue;
                    const title = clean(node.title || node.name);
                    if (!title) continue;
                    const url = node.url ? abs(node.url) : entryUrl;
                    const key = (title + '|' + url).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    let location = null;
                    const jl = node.jobLocation;
                    const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                    for (const l of arr) {
                        const addr = l && l.address;
                        const loc = addr && (addr.addressLocality || addr.addressRegion || addr.addressCountry);
                        if (loc) { location = typeof loc === 'string' ? loc : (loc.name || null); break; }
                    }

                    const hiring = node.hiringOrganization;
                    const organizer = (hiring && (hiring.name || hiring)) || 'Source Code Pvt. Ltd.';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `sourcecode-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Source Code Pvt. Ltd.',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'sourcecode',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Explicitly exclude the site's known marketing routes.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply|join-us)\/[^/?#]+/i;
            const excludeRe = /(product|services|aboutus|contact|assets|blog|case-studies)(\/|$|#|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer, .navbar, .footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (!raw) continue;
                if (/^(tel:|mailto:|javascript:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?|more)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `sourcecode-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Source Code Pvt. Ltd.',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'sourcecode',
                });
            }

            // ---- 3) Role headings inside an openings/join-us block ----
            const openingsHeadingRe = /(join us|join our team|open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies)|current opportunities?|careers? at source code)/i;
            const marketingHeadingRe = /^(products?|smart analytics( \(sa\))?|smart charts( \(sc\))?|market data provider( \(mdp\))?|stock analytics software( \(sas\))?|smart ?kyc( \(skyc\))?|sdmis|sdss|services|about us|company|our work|contact|who we are|offering truly unique|software solutions we offer|let['']?s connect|custom software development|mobile app development|web hosting services)$/i;

            // Skip cards in the known product/services/footer sections.
            const isNonJobCard = (el) => {
                if (!el) return false;
                if (el.closest('section.product')) return true;
                if (el.closest('.services-block')) return true;
                if (el.closest('.footer-information')) return true;
                if (el.closest('footer, .footer, nav, header')) return true;
                return false;
            };

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
                if (h.closest('nav, header, footer')) continue;
                if (isNonJobCard(h)) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 5 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, article, li, .job, .job-card, .vacancy, .position, .opening').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, h5, .job-title, .vacancy-title, .position-title, .opening-title'
                )) {
                    if (el.closest('nav, header, footer')) continue;
                    if (isNonJobCard(el)) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const card = el.closest('li, article, div') || el.parentElement;
                    if (!card) continue;

                    const ctrl = Array.from(card.querySelectorAll('a, button'))
                        .find((c) => /^apply( now)?$|view (role|job|details?)|read more/i
                            .test((c.textContent || '').trim()));

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const p = card.querySelector('p');
                    const description = p ? stripHtml(p.textContent) : null;

                    let href = null;
                    if (ctrl && ctrl.tagName === 'A') {
                        const raw = ctrl.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:|javascript:)/i.test(raw) && !/^#/.test(raw)) {
                            href = /^mailto:/i.test(raw) ? raw : abs(raw);
                        }
                    }

                    let attendanceMode = null;
                    const modeM = (card.textContent || '').match(/\b(Hybrid|Remote|On-?site|Onsite)\b/i);
                    if (modeM) {
                        const mm = modeM[1].toLowerCase();
                        if (mm.includes('remote')) attendanceMode = 'online';
                        else if (mm.includes('hybrid')) attendanceMode = 'hybrid';
                        else attendanceMode = 'in-person';
                    }

                    out.push({
                        id: `sourcecode-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Source Code Pvt. Ltd.',
                        category: null,
                        tags: [],
                        image: null,
                        url: href && !/^mailto:/i.test(href) ? href : entryUrl,
                        registrationUrl: href || entryUrl,
                        attendanceMode,
                        source: 'sourcecode',
                    });
                }
            }

            return out;
        }, SOURCECODE_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[sourcecode] no open roles found on /join-us/ - returning empty list (may be an empty careers page or Angular route resolved to home)');
        } else {
            console.log(`? [sourcecode] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};