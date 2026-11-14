// src/scrapers/extractors/jobs/alpastechnology.js
// Site-specific extractor for alpastechnology.com/careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The detected "detail-link pattern" `/` (5 matches) is just nav/logo
//     links, NOT job detail links. detailLinkCandidates is empty.
//   - The detected "card wrapper" `meta` (14 instances) is HTML metadata,
//     NOT job cards.
//   - There is no JobPosting JSON-LD. The page DOES contain an "Open roles"
//     section (seen in cardCandidates childSamples), so we harvest role
//     headings from that section defensively. If no role headings exist,
//     we return an empty list rather than inventing items.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ALPAS_CAREERS_URL = 'https://alpastechnology.com/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [alpastechnology] Scraping Alpas Technology careers...');

        meta.pagesVisited++;
        await page.goto(ALPAS_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // let client-side sections settle

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [alpastechnology] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);

            // ---- 1) JSON-LD JobPosting (if the site ever adds it) ----
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Alpas Technology';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `alpastechnology-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Alpas Technology',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'alpastechnology',
                    });
                }
            }

            // ---- 2) DOM fallback: the "Open roles" section ----
            // Evidence shows section.mb-14 blocks; one contains an "Open roles"
            // heading. Role cards themselves were not captured in the dump, so
            // we look for h2/h3/h4 headings inside that section and treat each
            // non-marketing heading as a role title.
            const marketingHeadingRe = /^(you|we|our|join|build|future|leading|partner|welcome|why|about|the |a |open roles)/i;
            const sections = Array.from(document.querySelectorAll('section.mb-14'));
            const openSection = sections.find((s) => {
                const h = s.querySelector('h1, h2, h3, h4');
                return /open roles/i.test(s.textContent) || (h && /open roles/i.test(h.textContent));
            });

            if (openSection) {
                const headings = Array.from(openSection.querySelectorAll('h2, h3, h4'))
                    .filter((h) => !/open roles/i.test(h.textContent || ''));

                for (const h of headings) {
                    const title = clean(h.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;

                    const card = h.closest('li, article, div') || h.parentElement;
                    if (!card || !openSection.contains(card)) continue;

                    const key = (title + '|' + entryUrl).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const p = card.querySelector('p');
                    const description = p ? stripHtml(p.textContent) : null;

                    const applyLink = card.querySelector('a[href^="mailto:"], a[href*="apply"], a[href*="career"]');
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    const imgEl = card.querySelector('img');
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `alpastechnology-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null, // per-role location not present in evidence
                        price: null,
                        organizer: 'Alpas Technology',
                        category: null,
                        tags: [],
                        image,
                        url: entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'alpastechnology',
                    });
                }
            }

            return out;
        }, ALPAS_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[alpastechnology] no scrapeable open roles found - returning empty list');
        } else {
            console.log(`? [alpastechnology] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};