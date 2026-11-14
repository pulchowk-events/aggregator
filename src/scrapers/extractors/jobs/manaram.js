// src/scrapers/extractors/jobs/manaram.js
// Site-specific extractor for manaram.group/career/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `line` (24 instances) is inline SVG artwork, NOT
//     job cards.
//   - The "detail-link pattern" `/` (19 matches) is nav / companies /
//     CSR / leadership links - detailLinkCandidates is empty; there are
//     no per-job detail hrefs in the dump.
//   - cardCandidates are perks articles ("Health cover", "Learning &
//     growth"), careers-path articles ("Craft & Production", "Food &
//     Hospitality") and section intros ("Six ways to grow.") - culture
//     copy, not roles.
//   - The "sample detail page" is actually /companies/#setotyami (a
//     group-brand page), not a job detail - ignore its selectors.
//   - The page IS the careers page (URL /career/; title "Career �
//     Manaram Group"; body opens "????? / Home / Career / Grow with us. /
//     Build a career in a family of companies...").
//   - No JSON-LD JobPosting (only Organization). No pagination.
//
// Strategy: extract defensively, since the dump bodySnippet is truncated
// mid-sentence ("Six ways to grow. From the wo.") and an "Open
// Positions" list may live further down or be rendered client-side:
//   1) JSON-LD JobPosting (none today, defensive)
//   2) real job-detail anchors - excluding nav/companies/csr/leadership
//      and external group brand sites (manaram.farm, manamake.com,
//      themomow.com, poshilofoods.com, manaramhimalyanhandicraft.com)
//   3) role headings inside a "Grow with us"/"Open positions"/"Join us"
//      block, with an explicit exclusion list for the known culture/
//      benefit/path headings from the dump.
// Return [] gracefully if nothing real is found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const MANARAM_CAREERS_URL = 'https://manaram.group/career/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [manaram] Scraping Manaram Group careers...');

        meta.pagesVisited++;
        await page.goto(MANARAM_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // allow any client-side role list to hydrate

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [manaram] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll the whole page - the careers block (open roles) may be
        // below the fold and lazily revealed via IntersectionObserver.
        try {
            const height = await page.evaluate(() => document.body.scrollHeight);
            const steps = Math.min(8, Math.ceil(height / 800));
            for (let i = 0; i < steps; i++) {
                await page.evaluate((y) => window.scrollTo(0, y), i * 800);
                await delay(300);
            }
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(800);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(300);
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Manaram Group';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `manaram-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Manaram Group',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'manaram',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude all the site's nav/company/CSR/leadership routes AND
            // the group's external brand sites.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply|opening)\/[^/?#]+/i;
            const excludeRe = /\/(about|companies|csr|leadership|contact|blog|privacy|terms)(\/|$|#|\.)/i;
            const externalBrandRe = /^https?:\/\/(www\.)?(manaram\.farm|manamake\.com|themomow\.com|poshilofoods\.com|manaramhimalyanhandicraft\.com)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (!raw) continue;
                if (/^(tel:|mailto:|javascript:)/i.test(raw)) continue;
                if (/^#/.test(raw)) continue;
                if (externalBrandRe.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(read more|apply( now)?|learn more|view details?|join us)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `manaram-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Manaram Group',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'manaram',
                });
            }

            // ---- 3) Role headings inside a Grow/Open-Positions block ----
            const openingsHeadingRe = /(grow with us|open positions?|open roles?|current openings?|we['']?re hiring|job openings?|vacanc(?:y|ies)|join (our|the) team|six ways to grow|careers? at manaram)/i;
            const marketingHeadingRe = /^(grow with us\.?|six ways? ?to grow\.?|from the wo|a full day|health cover|festival bonus|learning & growth|paid leave|craft & production|food & hospitality|separate brands|shared values|our companies|build a career in a family|five ways to grow\.?|career$)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 5 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .role, .opening, .position, article').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .role-title, .position-title, .opening-title'
                )) {
                    if (el.closest('nav, header, footer')) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const card = el.closest('li, article, div') || el.parentElement;
                    if (!card) continue;

                    // Require either an apply-style control or a job-role
                    // container - otherwise it's probably a culture/path
                    // card, not a real role.
                    const ctrl = Array.from(card.querySelectorAll('a, button'))
                        .find((c) => /^apply( now)?$|view (role|job|details?)|read more|apply now/i
                            .test((c.textContent || '').trim()));
                    const hasJobClass = card.matches('.job, .job-card, .role, .opening, .position, .path') ||
                        !!card.closest('.job, .job-card, .role, .opening, .position');
                    if (!ctrl && !hasJobClass) continue;

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const p = card.querySelector('p');
                    const description = p ? stripHtml(p.textContent) : null;

                    let registrationUrl = null;
                    let url = entryUrl;
                    if (ctrl && ctrl.tagName === 'A') {
                        const raw = ctrl.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:)/i.test(raw) && !/^#/.test(raw)) {
                            const resolved = abs(raw);
                            if (resolved) {
                                registrationUrl = resolved;
                                try {
                                    if (new URL(resolved).origin === window.location.origin) url = resolved;
                                } catch (e) { /* keep entryUrl */ }
                            }
                        }
                    }

                    out.push({
                        id: `manaram-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Manaram Group',
                        category: null,
                        tags: [],
                        image: null,
                        url,
                        registrationUrl: registrationUrl || url,
                        attendanceMode: null,
                        source: 'manaram',
                    });
                }
            }

            return out;
        }, MANARAM_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[manaram] no open roles found - returning empty list');
        } else {
            console.log(`? [manaram] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};