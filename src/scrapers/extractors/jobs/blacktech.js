// src/scrapers/extractors/jobs/blacktech.js
// Site-specific extractor for www.blacktech.com.np/career.
// See ../README.md for the contract.
//
// Site type: listing-to-detail. Detail links follow /career/<uuid>.
// Listing anchor text is densely packed, e.g.:
//   "Creative Graphic Designer|Mid LevelApply now Onsite Full Time 2 yrs1 - OpeningsDeadline: 2026-10-30"
// We parse that packed string for level / mode / type / experience / openings
// / deadline, then navigate each detail page for the full job description.
// Detail title selector confirmed from evidence: h2.primary-gradient-text.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const BLACKTECH_CAREERS_URL = 'https://www.blacktech.com.np/career';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [blacktech] Scraping Black Tech careers...');

        meta.pagesVisited++;
        await page.goto(BLACKTECH_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2000); // Next.js hydration

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [blacktech] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // ---- Stage 1: harvest listing cards ----
        const listing = await page.evaluate((listingUrl) => {
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
            const anchors = Array.from(document.querySelectorAll('a[href*="/career/"]'));
            const seen = new Set();
            const out = [];
            const listingPath = new URL(listingUrl).pathname;

            for (const a of anchors) {
                const raw = a.getAttribute('href');
                if (!raw) continue;
                let abs;
                try { abs = new URL(raw, window.location.origin); }
                catch { continue; }

                // Only real detail links (/career/<something>), not the listing itself.
                if (!abs.pathname.startsWith('/career/')) continue;
                if (abs.pathname.length <= '/career/'.length) continue;
                if (abs.pathname === listingPath) continue;
                if (seen.has(abs.href)) continue;
                seen.add(abs.href);

                const text = clean(a.textContent) || '';

                let title = null;
                let level = null;
                let mode = null;
                let employmentType = null;
                let experience = null;
                let openings = null;
                let deadline = null;

                const pipeIdx = text.indexOf('|');
                if (pipeIdx > 0) {
                    title = text.slice(0, pipeIdx).trim();
                    const afterPipe = text.slice(pipeIdx + 1);
                    const applyIdx = afterPipe.indexOf('Apply now');
                    if (applyIdx > 0) level = afterPipe.slice(0, applyIdx).trim();
                } else {
                    const applyIdx = text.indexOf('Apply now');
                    if (applyIdx > 0) title = text.slice(0, applyIdx).trim();
                }

                const modeM = text.match(/\b(On-?site|Onsite|Remote|Hybrid)\b/i);
                if (modeM) mode = modeM[1];

                const typeM = text.match(/\b(Full\s*Time|Part\s*Time|Contract|Internship|Freelance)\b/i);
                if (typeM) employmentType = typeM[1];

                const expM = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\+)?)/i);
                if (expM) experience = expM[1];

                const openM = text.match(/(\d+)\s*-\s*Openings?/i);
                if (openM) openings = parseInt(openM[1], 10);

                const dlM = text.match(/Deadline:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
                if (dlM) deadline = dlM[1];

                if (!title || title.length < 2 || title.length > 150) continue;

                out.push({
                    url: abs.href,
                    title,
                    level,
                    mode,
                    employmentType,
                    experience,
                    openings,
                    deadline,
                    listingText: text,
                });
            }
            return out;
        }, BLACKTECH_CAREERS_URL);

        meta.listingHits = listing.length;
        safeDiscovered(progress, listing.length);
        console.log(`? [blacktech] found ${listing.length} job listing(s)`);

        if (listing.length === 0) {
            return { items: [], meta };
        }

        // ---- Stage 2: visit each detail page ----
        for (const l of listing) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(l.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800);

                const titleResult = await pickOne(page, [
                    'h2.primary-gradient-text',
                    'h2[class*="primary-gradient-text"]',
                    'h1',
                    'h2',
                ], { label: `detail title (${l.url})` });

                const extras = await page.evaluate(() => {
                    const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);

                    // Description: longest div/section/article/main that contains
                    // job-ish vocabulary and is not nav/footer scaffolding.
                    let description = null;
                    let bestLen = 0;
                    const candidates = document.querySelectorAll('div, section, article, main');
                    for (const d of candidates) {
                        if (d.closest('nav, header, footer')) continue;
                        if (d.children.length > 30) continue; // skip page-level wrappers
                        const txt = d.textContent || '';
                        if (txt.length <= bestLen) continue;
                        if (txt.length < 200 || txt.length > 20000) continue;
                        if (!/responsibilit|requirement|qualification|experience|skills?/i.test(txt)) continue;
                        description = clean(txt);
                        bestLen = txt.length;
                    }

                    const bodyText = document.body.textContent || '';
                    const modeM = bodyText.match(/\b(On-?site|Onsite|Remote|Hybrid)\b/i);
                    const mode = modeM ? modeM[1] : null;

                    return {
                        description,
                        mode,
                        finalUrl: window.location.href,
                    };
                });

                if (!titleResult.value) {
                    meta.detailParseFailures++;
                    console.warn(`?? [blacktech] detail title extraction failed for ${l.url}`);
                    continue;
                }

                const attendanceMode = (() => {
                    const m = (l.mode || extras.mode || '').toLowerCase();
                    if (m.includes('remote') || m.includes('online')) return 'online';
                    if (m.includes('hybrid')) return 'hybrid';
                    return 'in-person';
                })();

                // Additional fields the shape allows: fold level/experience/openings
                // into tags since there is no dedicated column for them.
                const tags = [
                    l.level,
                    l.employmentType,
                    l.experience,
                    l.openings ? `${l.openings} openings` : null,
                ].filter(Boolean);

                items.push({
                    id: `blacktech-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: titleResult.value,
                    description: extras.description || l.listingText || null,
                    date: l.deadline || null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Black Tech',
                    category: l.level || null,
                    tags,
                    image: null,
                    url: extras.finalUrl || l.url,
                    registrationUrl: extras.finalUrl || l.url,
                    attendanceMode,
                    source: 'blacktech',
                });

                console.log(`    ? [blacktech] Scraped: ${titleResult.value}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [blacktech] 403 on ${l.url} - skipping.`);
                } else {
                    console.error(`    ? [blacktech] Error on ${l.url}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [blacktech] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};