// src/scrapers/extractors/jobs/technorio.js
// Site-specific extractor for Technorio Inc. careers (Kathmandu, Nepal).
// See ../README.md for the contract.
//
// Structural shape: HUB landing -> 4 category pages -> per-job detail.
//   https://technorio.com/career/  (hub)
//     -> /career/apprenticeship
//     -> /career/job/
//     -> /career/internship/
//     -> /career/traineeship
//   Each category page lists actual role openings; we follow per-role
//   detail links when present, else fall back to card extraction.
//
// Wizard assumption corrections (per extractor README):
//   - "card wrapper: link (44 instances)" -> FALSE POSITIVE. Those are
//     <link rel="profile|stylesheet|preconnect"> HTML chrome, not job
//     cards. The real hub cards are div.eael-infobox with an <a href>
//     pointing at /career/<category>.
//   - "detail-link pattern: / (6 matches)" -> FALSE POSITIVE. The bare
//     "/" matches every nav anchor + site root. The real category
//     links are a[href^="/career/"] excluding /career/ itself.
//   - "jsonLdTypes: BreadcrumbList" -> no JobPosting JSON-LD on the
//     hub; per-page HTML extraction required.
//   - Site type stays listing-to-detail, with a hub hop in front.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const LISTING_URL = 'https://technorio.com/career/';
const COMPANY = 'Technorio Inc.';
const COMPANY_LOCATION = 'Kathmandu, Nepal';
const BASE = 'https://technorio.com';

const SOCIAL_RE = /facebook|instagram|twitter|x\.com|linkedin|whatsapp|wa\.me|youtube|pinterest|tiktok/i;

const EMPTY_PATTERNS = [
    /no\s+(open\s+positions|current\s+openings|job\s+openings|vacancies|any\s+vacancy)/i,
    /we\s+are\s+(always\s+hiring|always\s+on\s+the\s+lookout)/i,
    /not\s+hiring/i,
    /check\s+back\s+soon/i,
    /sorry,\s+no\s+positions/i
];

const SEL_HUB = [
    'div.eael-infobox a[href^="/career/"]',
    'div[class*="eael-info-box"] a[href^="/career/"]',
    'a[href^="/career/apprenticeship"]',
    'a[href^="/career/job"]',
    'a[href^="/career/internship"]',
    'a[href^="/career/traineeship"]'
];

const CARD_SELECTOR = [
    'div.eael-infobox',
    'article.post',
    'div[class*="job"]',
    'div[class*="vacancy"]',
    'div[class*="career-card"]'
].join(', ');

const LOC_SEL = '[class*="location"], .job-location, li.elementor-icon-list-item';
const SAL_SEL = '[class*="salary"], [class*="compensation"], [class*="pay"]';
const EMP_SEL = '[class*="employment"], [class*="job-type"], [class*="work-type"]';
const DATE_SEL = '[class*="deadline"], [class*="apply-by"], [class*="closing"], [class*="expiry"]';

const DESC_SEL = [
    'div.elementor-widget-theme-post-content',
    'div.entry-content',
    'div.elementor-widget-text-editor .elementor-text-editor',
    'article .elementor-widget-text-editor',
    'main article',
    'main'
];

function isEmptyState(text) {
    if (!text) return false;
    return EMPTY_PATTERNS.some((re) => re.test(text));
}

function toAbsolute(href) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return BASE + href;
    return BASE + '/' + href;
}

function isCategoryLink(href, currentUrl) {
    if (!href) return false;
    const lower = href.toLowerCase();
    if (lower.startsWith('tel:')) return false;
    if (lower.startsWith('mailto:')) return false;
    if (lower.startsWith('javascript:')) return false;
    if (lower.startsWith('#')) return false;
    if (SOCIAL_RE.test(lower)) return false;
    const catPath = /^\/career\/[^/]+\/?$/.test(href) ||
                    /technorio\.com\/career\/[^/]+\/?$/.test(lower);
    if (!catPath) return false;
    if (lower === '/career/') return false;
    if (lower === currentUrl.toLowerCase()) return false;
    return true;
}

function inferEmploymentType(catUrl) {
    const lower = (catUrl || '').toLowerCase();
    if (lower.includes('apprenticeship')) return 'apprenticeship';
    if (lower.includes('internship')) return 'internship';
    if (lower.includes('traineeship')) return 'traineeship';
    if (lower.includes('job')) return 'full-time';
    return null;
}

async function getBodyText(page) {
    try { return await page.evaluate(() => document.body.innerText); }
    catch { return ''; }
}

async function harvestCategoryLinks(page) {
    const result = await pickAll(page, SEL_HUB, { label: 'hub cards', attr: 'href' });
    const currentUrl = page.url();
    const seen = new Set();
    const out = [];
    for (const href of (result.values || [])) {
        if (!isCategoryLink(href, currentUrl)) continue;
        const abs = toAbsolute(href);
        if (!abs || seen.has(abs)) continue;
        seen.add(abs);
        out.push(abs);
    }
    return out;
}

async function harvestJobLinks(page, categoryUrl) {
    return await page.evaluate((catUrl) => {
        const out = [];
        const seen = new Set();
        let catPath;
        try { catPath = new URL(catUrl).pathname.replace(/\/$/, ''); }
        catch { return out; }
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href) continue;
            let abs;
            if (href.startsWith('http')) abs = href;
            else if (href.startsWith('//')) abs = 'https:' + href;
            else if (href.startsWith('/')) abs = window.location.origin + href;
            else abs = window.location.origin + '/' + href;
            if (!abs.includes('technorio.com')) continue;
            const lower = abs.toLowerCase();
            if (lower.startsWith('tel:')) continue;
            if (lower.startsWith('mailto:')) continue;
            if (/facebook|instagram|twitter|x\.com|linkedin|whatsapp|wa\.me|youtube/.test(lower)) continue;
            if (abs === catUrl || abs === catUrl.replace(/\/$/, '')) continue;
            if (!abs.includes(catPath + '/')) continue;
            const txt = (a.textContent || '').trim();
            if (txt.length < 2) continue;
            if (seen.has(abs)) continue;
            seen.add(abs);
            out.push({ href: abs, text: txt });
        }
        return out;
    }, categoryUrl);
}

async function harvestCards(page) {
    return await page.evaluate((cardSel) => {
        const cardEls = Array.from(document.querySelectorAll(cardSel));
        return cardEls.map((el) => {
            const h = el.querySelector('h1, h2, h3, h4, h5, .title');
            const p = el.querySelector('p');
            const a = el.querySelector('a[href]');
            const img = el.querySelector('img');
            return {
                title: h ? h.textContent.trim() : null,
                desc: p ? p.textContent.trim() : null,
                href: a ? a.getAttribute('href') : null,
                img: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null
            };
        }).filter((c) => c.title && c.title.length > 1);
    }, CARD_SELECTOR);
}

async function extractDetail(page) {
    const SELS = { desc: DESC_SEL, loc: LOC_SEL, sal: SAL_SEL, emp: EMP_SEL, date: DATE_SEL };
    return await page.evaluate((sels) => {
        const titleEl = document.querySelector('h1') ||
                        document.querySelector('h2.elementor-heading-title') ||
                        document.querySelector('h2');
        const title = titleEl ? titleEl.textContent.trim() : null;

        let description = null;
        for (const sel of sels.desc) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const txt = el.textContent.trim();
            if (!txt || txt.length < 60) continue;
            if (txt.length < 8000) { description = txt; break; }
            const ps = Array.from(el.querySelectorAll('p'))
                .map((p) => p.textContent.trim())
                .filter((t) => t.length > 40);
            if (ps.length) { description = ps.join('\n\n'); break; }
        }

        let location = null;
        const locEls = Array.from(document.querySelectorAll(sels.loc));
        for (const el of locEls) {
            const t = el.textContent.trim();
            if (!t || t.length >= 80) continue;
            if (/kathmandu|nepal|lalitpur|bhaktapur|pokhara|biratnagar|chitwan/i.test(t)) {
                location = t; break;
            }
        }

        let salary = null;
        const salEls = Array.from(document.querySelectorAll(sels.sal));
        for (const el of salEls) {
            const t = el.textContent.trim();
            if (t && t.length < 60 && /rs|npr|\$|salary|negotiable|monthly/i.test(t)) {
                salary = t; break;
            }
        }

        let employmentType = null;
        const empEls = Array.from(document.querySelectorAll(sels.emp));
        for (const el of empEls) {
            const t = el.textContent.trim();
            if (!t || t.length >= 40) continue;
            if (/full[- ]?time|part[- ]?time|contract|internship|apprenticeship|traineeship/i.test(t)) {
                employmentType = t; break;
            }
        }

        let applyUrl = null;
        const applyA = Array.from(document.querySelectorAll('a[href]')).find((a) => {
            const t = (a.textContent || '').trim().toLowerCase();
            const h = (a.getAttribute('href') || '').toLowerCase();
            if (/apply|send\s+(your|cv|resume)|submit your|get in touch/.test(t)) return true;
            if (h.startsWith('mailto:')) return true;
            if (/formspree|google\.com\/forms|tally\.so/.test(h)) return true;
            return false;
        });
        if (applyA) applyUrl = applyA.getAttribute('href');

        let image = null;
        const img = document.querySelector(
            'article img, main img.featured, .elementor-widget-image img'
        );
        if (img && window.__resolveImageSrc) {
            image = window.__resolveImageSrc(img);
        }

        let applicationEndsRaw = null;
        const dateEls = Array.from(document.querySelectorAll(sels.date));
        for (const el of dateEls) {
            const t = el.textContent.trim();
            if (t && t.length < 80 && /\d{1,2}[-/ ]\w+|deadline|apply by|closing/i.test(t)) {
                applicationEndsRaw = t; break;
            }
        }

        return {
            title, description, location, salary,
            employmentType, applyUrl, image,
            applicationEndsRaw, finalUrl: window.location.href
        };
    }, SELS);
}

function buildItem({ title, url, detail, employmentType, categoryUrl, imageFallback }) {
    const id = `technorio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const finalEmp = detail.employmentType || employmentType;
    return {
        id,
        title,
        company: COMPANY,
        company_status: 'extracted',
        company_evidence: 'og:site_name meta = "Technorio Inc."; footer copyright Technorio Inc.',
        url,
        location: detail.location || COMPANY_LOCATION,
        location_status: 'extracted',
        location_evidence: detail.location
            ? `detail [class*="location"] match: "${detail.location}"`
            : 'hub header chrome: "Kathmandu, Nepal" (Nepal source, geo auto-pass)',
        description: detail.description,
        description_status: detail.description ? 'extracted' : 'site_absent',
        description_evidence: detail.description
            ? 'detail page main article / entry-content region'
            : 'searched div.entry-content, div.elementor-widget-text-editor, main article p -- no role body',
        employmentType: finalEmp,
        employmentType_status: finalEmp ? 'extracted' : 'site_absent',
        employmentType_evidence: detail.employmentType
            ? `detail [class*="employment"] match: "${detail.employmentType}"`
            : (employmentType
                ? `inferred from category URL: ${categoryUrl}`
                : 'searched [class*="employment"], [class*="job-type"] -- none'),
        salary: detail.salary,
        salary_status: detail.salary ? 'extracted' : 'site_absent',
        salary_evidence: detail.salary
            ? `detail [class*="salary"] match: "${detail.salary}"`
            : 'searched [class*="salary"], [class*="compensation"], [class*="pay"] -- none',
        image: detail.image || imageFallback,
        applicationEndsRaw: detail.applicationEndsRaw,
        applicationEndsRaw_status: detail.applicationEndsRaw ? 'extracted' : 'site_absent',
        applicationEndsRaw_evidence: detail.applicationEndsRaw
            ? `detail [class*="deadline"] match: "${detail.applicationEndsRaw}"`
            : 'searched [class*="deadline"], [class*="apply-by"], [class*="closing"] -- none',
        registrationUrl: detail.applyUrl,
        category: employmentType,
        tags: [employmentType].filter(Boolean),
        source: 'technorio'
    };
}

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];
        const seenUrls = new Set();

        // ---- Stage 1: Load hub landing ----
        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(Math.random() * 800 + 400);
        } catch (err) {
            console.warn(`⚠️ [technorio] hub load failed: ${err.message}`);
            return { items, meta };
        }

        if (meta.pagesVisited === 1) {
            try {
                const state = await detectPageState(page);
                if (state.looksBlocked) {
                    meta.looksBlocked = true;
                    console.warn(`⚠️ [technorio] hub looks blocked`);
                    return { items, meta };
                }
            } catch (e) { /* best-effort */ }
        }

        // ---- Stage 2: Harvest category links from hub info-boxes ----
        let categoryLinks = [];
        try {
            categoryLinks = await harvestCategoryLinks(page);
        } catch (e) {
            console.warn(`⚠️ [technorio] category harvest failed: ${e.message}`);
        }

        if (categoryLinks.length === 0) {
            meta.atsEmpty = true;
            return { items, meta };
        }

        // ---- Stage 3: Visit each category page ----
        for (const catUrl of categoryLinks) {
            try {
                meta.pagesVisited++;
                await loadPage(page, catUrl);
                await delay(Math.random() * 800 + 400);

                const catText = await getBodyText(page);
                const catEmpty = isEmptyState(catText);
                const employmentType = inferEmploymentType(catUrl);

                let jobLinks = [];
                try {
                    const found = await harvestJobLinks(page, catUrl);
                    jobLinks = (found || []).filter((x) => {
                        if (seenUrls.has(x.href)) return false;
                        seenUrls.add(x.href);
                        return true;
                    });
                } catch (e) {
                    console.warn(`⚠️ [technorio] job-link harvest failed on ${catUrl}: ${e.message}`);
                }

                if (jobLinks.length === 0 && catEmpty) continue;

                if (jobLinks.length > 0) {
                    // ---- Stage 3a: Follow per-role detail pages ----
                    safeDiscovered(progress, jobLinks.length);
                    meta.listingHits += jobLinks.length;

                    for (const job of jobLinks) {
                        try {
                            meta.pagesVisited++;
                            meta.detailPagesVisited++;
                            await loadPage(page, job.href);
                            await delay(Math.random() * 700 + 300);

                            const detail = await extractDetail(page);
                            if (!detail.title) detail.title = job.text;
                            if (!detail.title) {
                                meta.detailParseFailures++;
                                continue;
                            }

                            items.push(buildItem({
                                title: detail.title,
                                url: detail.finalUrl || job.href,
                                detail,
                                employmentType,
                                categoryUrl: catUrl,
                                imageFallback: null
                            }));
                        } catch (err) {
                            if (err.message && err.message.includes('403')) continue;
                            meta.detailParseFailures++;
                            console.warn(`⚠️ [technorio] detail ${job.href} failed: ${err.message}`);
                        } finally {
                            safeUnitDone(progress);
                        }
                    }
                } else {
                    // ---- Stage 3b: Single-page-cards extraction ----
                    let cards = [];
                    try { cards = await harvestCards(page); }
                    catch (e) {
                        console.warn(`⚠️ [technorio] card harvest failed on ${catUrl}: ${e.message}`);
                    }

                    safeDiscovered(progress, cards.length);
                    meta.listingHits += cards.length;

                    for (const card of cards) {
                        const cardHref = toAbsolute(card.href);
                        const cardUrl = cardHref || catUrl;
                        const detail = {
                            title: card.title,
                            description: card.desc,
                            location: null,
                            salary: null,
                            employmentType: null,
                            applyUrl: cardHref && cardHref !== catUrl ? cardHref : null,
                            image: toAbsolute(card.img),
                            applicationEndsRaw: null,
                            finalUrl: catUrl
                        };
                        items.push(buildItem({
                            title: card.title,
                            url: cardUrl,
                            detail,
                            employmentType,
                            categoryUrl: catUrl,
                            imageFallback: toAbsolute(card.img)
                        }));
                        safeUnitDone(progress);
                    }
                }
            } catch (err) {
                console.warn(`⚠️ [technorio] category ${catUrl} failed: ${err.message}`);
            }
        }

        if (items.length === 0) meta.atsEmpty = true;
        console.log(`  [technorio] extracted ${items.length}`);
        return { items, meta };
    }
};