// src/scrapers/extractors/jobs/softnep.js
// Site-specific extractor for softnep.com/career.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "card wrapper" `meta` (25) is HTML metadata.
//   - The "detail-link pattern" `/` (4 matches) is only the logo + nav
//     "Home" links. detailLinkCandidates is empty - no per-job hrefs were
//     captured.
//   - cardCandidates are (a) nav <li>s ("Home", etc.) and (b) the "Write
//     Us" contact block (div.items.col-xs-12.col-sm-4.col-md-4 with
//     headings "General Inquiry", "Marketing", "Phone"). Neither is a job
//     card - MUST NOT be emitted as roles.
//   - The page IS the careers page (title "IT Career in Nepal, Vacancy in
//     a Software Company"; body: "Career / HOME CAREER / SoftNEP is where
//     curious people build things that matter... If that sounds like your
//     kind of place, welcome"). The bodySnippet is truncated mid-sentence,
//     so an openings list may exist below the fold or be rendered
//     client-side (WordPress + wow.js / fadeInUp animations).
//
// Strategy: defensive, no invented items -
//   1) JSON-LD JobPosting (defensive; none present today)
//   2) real job-detail anchors (/career/<slug>, /job/<slug>,
//      /vacancy/<slug>, /apply) - explicitly excluding the site's known
//      nav / contact / service routes.
//   3) role headings inside an "openings"/"vacancies"/"join our team"
//      block, with an exclusion list that covers the "Write Us" contact
//      block headings and site chrome.
// Return [] gracefully if the openings list is empty.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const SOFTNEP_CAREERS_URL = 'https://www.softnep.com/career';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [softnep] Scraping SoftNEP careers...');

        meta.pagesVisited++;
        await page.goto(SOFTNEP_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000); // WordPress + wow.js fadeInUp

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [softnep] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Scroll through the page so any wow.js/lazy section becomes visible.
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'SoftNEP';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `softnep-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'SoftNEP',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'softnep',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // Exclude all known non-job routes on softnep.com.
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|roles?|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services|works|blog|contact|our-team|request-a-quote|software-development-company|about|team)(\/|$|#|\.)/i;
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
                if (/^(read more|apply( now)?|learn more|view details?|go top)$/i.test(title)) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `softnep-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'SoftNEP',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'softnep',
                });
            }

            // ---- 3) Role headings inside an openings block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies)|join our team|current opportunities?|open vacancies|available positions?)/i;
            // Explicitly exclude the "Write Us" contact block + site chrome.
            const marketingHeadingRe = /^(write us|general inquiry|marketing|phone|email|address|home|services|works|about|blog|career|contact|team|request a quote|go top|career at softnep|home career)$/i;

            // Skip cards nested in the contact "Write Us" block.
            const isNonJobCard = (el) => {
                if (!el) return false;
                if (el.closest('.items.col-xs-12.col-sm-4.col-md-4')) return true;
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
                    if (container.querySelectorAll('h3, h4, article, li, .job, .job-card, .vacancy, .position').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .vacancy-title, .position-title, .opening-title'
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
                    if (!ctrl) continue;

                    const key = title.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    let href = null;
                    if (ctrl.tagName === 'A') {
                        const raw = ctrl.getAttribute('href') || '';
                        if (raw && !/^(tel:|mailto:|javascript:)/i.test(raw) && !/^#/.test(raw)) {
                            href = /^mailto:/i.test(raw) ? raw : abs(raw);
                        }
                    }

                    const p = card.querySelector('p');
                    const description = p ? stripHtml(p.textContent) : null;

                    let attendanceMode = null;
                    const modeM = (card.textContent || '').match(/\b(Hybrid|Remote|On-?site|Onsite)\b/i);
                    if (modeM) {
                        const mm = modeM[1].toLowerCase();
                        if (mm.includes('remote')) attendanceMode = 'online';
                        else if (mm.includes('hybrid')) attendanceMode = 'hybrid';
                        else attendanceMode = 'in-person';
                    }

                    out.push({
                        id: `softnep-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'SoftNEP',
                        category: null,
                        tags: [],
                        image: null,
                        url: href && !/^mailto:/i.test(href) ? href : entryUrl,
                        registrationUrl: href || entryUrl,
                        attendanceMode,
                        source: 'softnep',
                    });
                }
            }

            return out;
        }, SOFTNEP_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[softnep] no open roles found on /career - returning empty list (page may currently have no listings)');
        } else {
            console.log(`? [softnep] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};