// Site-specific extractor. See ../README.md for the contract.
// Structural shape: real server-rendered category listing (pagination via
// rel=next or a "Next" link) -> per-job detail.
//
// Two things unique to KumariJob:
//   1. The listing card's badges (level/employmentType/experience) are
//      free-text in no guaranteed order — classifyKumariJobBadge sorts by
//      content, not position.
//   2. "Apply Now" often points OFFSITE (LinkedIn, employer ATS). We trust
//      it only when it's a well-formed http(s) URL; otherwise registrationUrl
//      falls back to the KumariJob detail page itself.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    parseKumariExpiryDate,
    classifyKumariJobBadge,
    sanitizeJobFields
} = require('../../jobs');
const { isValidRegistrationUrl } = require('../../../core/normalize');

const KUMARIJOB_BASE_URL = 'https://www.kumarijob.com';
const KUMARIJOB_CATEGORY_URLS = [
    `${KUMARIJOB_BASE_URL}/jobs-in-nepal/full-stack-development-jobs-in-nepal`,
    `${KUMARIJOB_BASE_URL}/jobs-in-nepal/ai-machine-learning-engineer-jobs-in-nepal`,
    `${KUMARIJOB_BASE_URL}/jobs-in-nepal/3d-designer-animator-jobs-in-nepal`,
    `${KUMARIJOB_BASE_URL}/jobs-in-nepal/software-engineering-jobs-in-nepal`
];
const KUMARIJOB_MAX_PAGES_PER_CATEGORY = 20;

async function gatherLinks(page) {
    const linksMap = new Map();

    const harvestVisible = async () => {
        const rows = await page.evaluate(() => {
            const getText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
            const cards = Array.from(document.querySelectorAll('div.job-container'));
            return cards.map((card) => {
                const titleLink = card.querySelector('h2 a[href]') || card.querySelector('a.view-detail-btn');
                if (!titleLink) return null;
                const href = titleLink.getAttribute('href');
                const title = getText(card.querySelector('h2 a') || titleLink);

                const companyLinkEl = card.querySelector('a.link-route');
                const company = companyLinkEl ? getText(companyLinkEl) : null;
                const companyUrl = companyLinkEl ? companyLinkEl.getAttribute('href') : null;

                const logoImg = card.querySelector('img[alt]');
                const companyLogoSrc = logoImg ? logoImg.getAttribute('src') : null;

                const location = getText(card.querySelector('span.district-text'));
                const salaryText = getText(card.querySelector('span.salary'));
                const postedDateText = getText(card.querySelector('span.sidebar-date'));
                const expiringSoon = Boolean(card.querySelector('span.expires-soon-text'));
                const badges = Array.from(card.querySelectorAll('div.job-card-time')).map(getText).filter(Boolean);

                return { href, title, company, companyUrl, companyLogoSrc, location, salaryText, postedDateText, expiringSoon, badges };
            }).filter(Boolean);
        });
        for (const row of rows) {
            if (row.href && !linksMap.has(row.href)) linksMap.set(row.href, row);
        }
    };

    const getNextPageHref = async () => page.evaluate(() => {
        const relNext = document.querySelector('a[rel="next"]');
        if (relNext && relNext.getAttribute('aria-disabled') !== 'true' && !relNext.classList.contains('disabled')) {
            return relNext.getAttribute('href');
        }
        const candidates = Array.from(document.querySelectorAll('nav a, .pagination a, a.page-link'));
        const next = candidates.find((a) => {
            const t = (a.textContent || '').trim().toLowerCase();
            return (t === 'next' || t === '›' || t === '»') && a.getAttribute('aria-disabled') !== 'true' && !a.classList.contains('disabled');
        });
        return next ? next.getAttribute('href') : null;
    });

    await harvestVisible();

    for (let i = 0; i < KUMARIJOB_MAX_PAGES_PER_CATEGORY; i++) {
        const nextHref = await getNextPageHref();
        if (!nextHref) break;
        const nextUrl = nextHref.startsWith('http') ? nextHref : `${KUMARIJOB_BASE_URL}${nextHref}`;
        await delay(1000 + Math.random() * 800);
        await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await harvestVisible();
    }

    return Array.from(linksMap.values());
}

async function scrapeDetail(page) {
    return page.evaluate(() => {
        const getText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
        const container = document.querySelector('div.content-wrap') || document.body;

        const title = getText(container.querySelector('h1 span')) || getText(container.querySelector('h1'));
        const company = getText(container.querySelector('.company-name'));
        const companyLinkEl = container.querySelector('.company-info a[href]');
        const companyUrl = companyLinkEl ? companyLinkEl.getAttribute('href') : null;
        const logoEl = container.querySelector('.company-logo img');
        const companyLogoUrl = logoEl ? logoEl.getAttribute('src') : null;

        const rows = {};
        container.querySelectorAll('ul.job-detail-box li.row').forEach((li) => {
            const label = getText(li.querySelector('.basic-item__left'));
            const value = getText(li.querySelector('.basic-item__right'));
            if (label && value) rows[label] = value;
        });

        const descEl = container.querySelector('.job-description-wrap');
        let description = '';
        if (descEl) {
            const nodes = descEl.querySelectorAll('p, li, strong');
            description = Array.from(nodes)
                .map((n) => (n.tagName === 'LI' ? `• ${getText(n)}` : getText(n)))
                .filter(Boolean)
                .join('\n');
        }

        const applyLink = Array.from(container.querySelectorAll('a.btn-primary, a'))
            .find((a) => /apply now/i.test((a.textContent || '').trim()));
        const applyUrl = applyLink ? applyLink.getAttribute('href') : null;

        return {
            title, company, companyUrl, companyLogoUrl,
            industry: rows['Industry'] || null,
            category: rows['Category'] || null,
            location: rows['Location'] || null,
            expiryDateRaw: rows['Expiry date'] || null,
            description,
            applyUrl
        };
    });
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];
        let allEntries = [];

        for (const categoryUrl of KUMARIJOB_CATEGORY_URLS) {
            console.log(`🕷️ [kumarijob] Scraping category: ${categoryUrl}`);
            meta.pagesVisited++;
            await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(1500 + Math.random() * 1000);

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [kumarijob] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            const entries = await gatherLinks(page);
            allEntries = allEntries.concat(entries);
        }

        const seen = new Map();
        for (const e of allEntries) {
            if (e.href && !seen.has(e.href)) seen.set(e.href, e);
        }
        const linkEntries = Array.from(seen.values());
        meta.listingHits = linkEntries.length;
        console.log(`✅ [kumarijob] Found ${linkEntries.length} job link(s)`);
        safeDiscovered(progress, linkEntries.length);

        for (const entry of linkEntries) {
            const link = entry.href.startsWith('http') ? entry.href : `${KUMARIJOB_BASE_URL}${entry.href}`;
            try {
                console.log(`  📄 [kumarijob] Scraping job: ${link}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800 + Math.random() * 800);

                const raw = await scrapeDetail(page);
                if (!raw.title && !entry.title) {
                    meta.detailParseFailures++;
                    console.warn(`⚠️ [kumarijob] no title on ${link}`);
                    continue;
                }

                const expirySource = raw.expiryDateRaw || entry.postedDateText || null;
                const { cleaned: applicationEndsRaw, date: applicationEndsDate } = parseKumariExpiryDate(expirySource);

                let level = null, employmentType = null, experience = null;
                for (const badgeText of (entry.badges || [])) {
                    const classified = classifyKumariJobBadge(badgeText);
                    if (!classified) continue;
                    if (classified.field === 'level' && !level) level = classified.value;
                    else if (classified.field === 'employmentType' && !employmentType) employmentType = classified.value;
                    else if (classified.field === 'experience' && !experience) experience = classified.value;
                }

                const companyLogoUrl = raw.companyLogoUrl || entry.companyLogoSrc || null;
                const resolvedLocation = raw.location || entry.location || null;

                const rawCompanyUrl = raw.companyUrl || entry.companyUrl || null;
                const companyUrlFull = rawCompanyUrl
                    ? (rawCompanyUrl.startsWith('http') ? rawCompanyUrl : `${KUMARIJOB_BASE_URL}${rawCompanyUrl}`)
                    : null;

                const finalJob = {
                    id: `kumarijob-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: raw.title || entry.title || 'Untitled Job',
                    company: raw.company || entry.company || null,
                    companyUrl: companyUrlFull,
                    companyLogoUrl,
                    location: resolvedLocation,
                    employmentType: employmentType || null,
                    attendanceMode: (resolvedLocation && /remote/i.test(resolvedLocation)) ? 'Remote' : null,
                    salary: entry.salaryText || null,
                    experience: experience || null,
                    level: level || null,
                    openings: null,
                    description: raw.description || '',
                    responsibilities: '',
                    requirements: '',
                    skills: [],
                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,
                    applicationEndsRaw,
                    applicationEndsDate,
                    daysLeftAtListTime: entry.expiringSoon ? 'Expiring Soon' : null,
                    url: link,
                    registrationUrl: isValidRegistrationUrl(raw.applyUrl) ? raw.applyUrl : link,
                    source: 'kumarijob',
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(finalJob);
                items.push(finalJob);
                console.log(`    ✅ [kumarijob] Scraped: ${finalJob.title}`);
                await delay(800);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`⚠️ [kumarijob] 403 on ${link} – skipping.`);
                    continue;
                }
                console.error(`    ❌ [kumarijob] Error scraping ${link}:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};
