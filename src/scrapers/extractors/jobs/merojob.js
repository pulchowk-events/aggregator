// Private extractor — gitignored. See ../README.md for the contract.
// Structural shape: real server-rendered category listing (pagination via
// "Next" link, no virtualized scrolling) -> per-job detail.
//
// Two things unique to MeroJob:
//   1. Deadlines are RELATIVE ("15 days from now"). applicationEndsDate is
//      computed by parseRelativeToDate, and applicationEndsRaw is
//      SYNTHESIZED from that (formatted as "August 18, 2026") so
//      downstream date parsing sees a real ISO-shaped date.
//   2. Company logos go through Next.js's /_next/image proxy; the real
//      URL is decoded out via extractRealImageUrl.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    parseRelativeToDate,
    extractRealImageUrl,
    sanitizeJobFields
} = require('../../jobs');

const MEROJOB_BASE_URL = 'https://merojob.com';
const MEROJOB_CATEGORY_URLS = [
    `${MEROJOB_BASE_URL}/category/it-telecommunication?limit=100`
];
const MEROJOB_MAX_PAGES_PER_CATEGORY = 20;

async function gatherLinks(page) {
    const linksMap = new Map();

    const harvestVisible = async () => {
        const rows = await page.evaluate(() => {
            const getText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
            const cards = Array.from(document.querySelectorAll('div.my-4.break-words'));
            return cards.map((card) => {
                const titleLink = card.querySelector('h3 a[href]');
                if (!titleLink) return null;
                const href = titleLink.getAttribute('href');
                const title = getText(titleLink);

                const companyLinkEl = card.querySelector('a[href^="/employer/"]');
                const company = companyLinkEl ? getText(companyLinkEl) : null;
                const companyUrl = companyLinkEl ? companyLinkEl.getAttribute('href') : null;

                const logoImg = card.querySelector('img[alt]');
                const companyLogoSrc = logoImg ? logoImg.getAttribute('src') : null;

                const deadlineEl = Array.from(card.querySelectorAll('span'))
                    .find((s) => /deadline:/i.test(s.textContent || ''));
                const deadlineText = deadlineEl ? getText(deadlineEl).replace(/^deadline:\s*/i, '') : null;

                return { href, title, company, companyUrl, companyLogoSrc, deadlineText };
            }).filter(Boolean);
        });
        for (const row of rows) {
            if (row.href && !linksMap.has(row.href)) linksMap.set(row.href, row);
        }
    };

    const getNextPageHref = async () => page.evaluate(() => {
        const nextLink = document.querySelector('a[aria-label="Go to next page"]');
        if (!nextLink) return null;
        if (nextLink.getAttribute('aria-disabled') === 'true') return null;
        if (nextLink.classList.contains('pointer-events-none')) return null;
        return nextLink.getAttribute('href');
    });

    await harvestVisible();

    for (let i = 0; i < MEROJOB_MAX_PAGES_PER_CATEGORY; i++) {
        const nextHref = await getNextPageHref();
        if (!nextHref) break;
        const nextUrl = nextHref.startsWith('http') ? nextHref : `${MEROJOB_BASE_URL}${nextHref}`;
        await delay(1000 + Math.random() * 800);
        await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await harvestVisible();
    }

    return Array.from(linksMap.values());
}

async function scrapeDetail(page) {
    return page.evaluate(() => {
        const getText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
        const cleanIconText = (text) => (text ? text.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim() : null);

        const title = getText(document.querySelector('h1'));

        const getTextByIconClass = (iconClass) => {
            const icon = document.querySelector(`svg.lucide-${iconClass}`);
            if (!icon) return null;
            const wrapper = icon.closest('div.flex.items-center.gap-2') || (icon.parentElement ? icon.parentElement.parentElement : null);
            if (!wrapper) return null;
            const clone = wrapper.cloneNode(true);
            clone.querySelectorAll('svg').forEach((s) => s.remove());
            return cleanIconText(clone.textContent);
        };

        const category = getTextByIconClass('briefcase');
        const level = getTextByIconClass('building');
        const employmentType = getTextByIconClass('clock3') || getTextByIconClass('clock-3');
        const vacancyRaw = getTextByIconClass('users');
        const location = getTextByIconClass('map-pin');
        const experienceRaw = getTextByIconClass('calendar');
        const salaryRaw = getTextByIconClass('wallet');

        const vacancy = vacancyRaw ? vacancyRaw.replace(/^vacancy:\s*/i, '').trim() : null;
        const experienceTop = experienceRaw ? experienceRaw.replace(/^experience:\s*/i, '').trim() : null;

        const stats = {};
        document.querySelectorAll('div.flex.gap-4').forEach((row) => {
            const spans = Array.from(row.children).filter((c) => c.tagName === 'SPAN');
            if (spans.length >= 2) {
                const label = getText(spans[0]);
                const value = getText(spans[spans.length - 1]);
                if (label && value && label !== value) stats[label] = value;
            }
        });

        const findSectionContent = (headerText) => {
            const headers = Array.from(document.querySelectorAll('p'));
            const header = headers.find((p) => (p.textContent || '').trim().toLowerCase() === headerText.toLowerCase());
            if (!header || !header.parentElement) return null;
            return header.parentElement.nextElementSibling;
        };

        const extractStructuredText = (container) => {
            if (!container) return '';
            const nodes = container.querySelectorAll('p, li');
            if (nodes.length === 0) return getText(container) || '';
            return Array.from(nodes)
                .map((n) => (n.tagName === 'LI' ? `• ${getText(n)}` : getText(n)))
                .filter(Boolean)
                .join('\n');
        };

        const description = extractStructuredText(findSectionContent('Job Description'));
        const otherSpecification = extractStructuredText(findSectionContent('Other Specification'));

        const skillsContainer = findSectionContent('Skills Required');
        const skills = skillsContainer ? Array.from(skillsContainer.children).map(getText).filter(Boolean) : [];

        let companyDescription = null;
        let companyLocation = null;
        let companyAddress = null;
        const aboutContainer = findSectionContent('About the Organization') || findSectionContent('About Organization');
        if (aboutContainer) {
            const paras = Array.from(aboutContainer.querySelectorAll('p'));
            for (const p of paras) {
                const t = getText(p) || '';
                if (/^location:/i.test(t)) companyLocation = t.replace(/^location:\s*/i, '');
                else if (/^address:/i.test(t)) companyAddress = t.replace(/^address:\s*/i, '');
            }
            if (!companyDescription) companyDescription = extractStructuredText(aboutContainer) || null;
        }

        let deadlineRelativeText = null;
        const applyBeforeMatch = document.body.innerText.match(/Apply Before:\s*([^\n]+)/i);
        if (applyBeforeMatch) deadlineRelativeText = applyBeforeMatch[1].trim();

        return {
            title,
            category: category || null,
            level: level || null,
            employmentType: employmentType || null,
            vacancy: vacancy || null,
            location: location || null,
            experience: experienceTop || stats['Required Experience'] || null,
            salary: salaryRaw || stats['Offered Salary'] || null,
            requiredEducationLevel: stats['Required Education Level'] || null,
            description, otherSpecification, skills,
            companyDescription, companyLocation, companyAddress,
            deadlineRelativeText
        };
    });
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];
        let allEntries = [];

        for (const categoryUrl of MEROJOB_CATEGORY_URLS) {
            console.log(`🕷️ [merojob] Scraping category: ${categoryUrl}`);
            meta.pagesVisited++;
            await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(1500 + Math.random() * 1000);

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [merojob] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            const entries = await gatherLinks(page);
            allEntries = allEntries.concat(entries);
        }

        // De-dupe cross-listed entries
        const seen = new Map();
        for (const e of allEntries) {
            if (e.href && !seen.has(e.href)) seen.set(e.href, e);
        }
        const linkEntries = Array.from(seen.values());
        meta.listingHits = linkEntries.length;
        console.log(`✅ [merojob] Found ${linkEntries.length} job link(s)`);
        safeDiscovered(progress, linkEntries.length);

        for (const entry of linkEntries) {
            const link = entry.href.startsWith('http') ? entry.href : `${MEROJOB_BASE_URL}${entry.href}`;
            try {
                console.log(`  📄 [merojob] Scraping job: ${link}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800 + Math.random() * 800);

                const raw = await scrapeDetail(page);
                if (!raw.title && !entry.title) {
                    meta.detailParseFailures++;
                    console.warn(`⚠️ [merojob] no title on ${link}`);
                    continue;
                }

                const scrapedAt = Date.now();
                const deadlineSourceText = raw.deadlineRelativeText || entry.deadlineText || null;
                const applicationEndsDate = parseRelativeToDate(deadlineSourceText, new Date(scrapedAt));
                const applicationEndsRaw = applicationEndsDate
                    ? applicationEndsDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                    : null;

                const companyLogoUrl = extractRealImageUrl(entry.companyLogoSrc, MEROJOB_BASE_URL);

                const requirementsParts = [];
                if (raw.requiredEducationLevel) requirementsParts.push(`Required Education Level: ${raw.requiredEducationLevel}`);
                if (raw.otherSpecification) requirementsParts.push(raw.otherSpecification);

                const finalJob = {
                    id: `merojob-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: raw.title || entry.title || 'Untitled Job',
                    company: entry.company || null,
                    companyUrl: entry.companyUrl ? `${MEROJOB_BASE_URL}${entry.companyUrl}` : null,
                    companyLogoUrl: companyLogoUrl || null,
                    location: raw.location || null,
                    employmentType: raw.employmentType || null,
                    attendanceMode: (raw.location && /remote/i.test(raw.location)) ? 'Remote' : null,
                    salary: raw.salary || null,
                    experience: raw.experience || null,
                    level: raw.level || null,
                    openings: raw.vacancy || null,
                    description: raw.description || '',
                    responsibilities: '',
                    requirements: requirementsParts.join('\n\n'),
                    skills: raw.skills || [],
                    companyDescription: raw.companyDescription || '',
                    companyLocation: raw.companyLocation || null,
                    companyAddress: raw.companyAddress || null,
                    applicationEndsRaw,
                    applicationEndsDate,
                    daysLeftAtListTime: entry.deadlineText || null,
                    url: link,
                    registrationUrl: link,
                    source: 'merojob',
                    scrapedAt
                };

                sanitizeJobFields(finalJob);
                items.push(finalJob);
                console.log(`    ✅ [merojob] Scraped: ${finalJob.title}`);
                await delay(800);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`⚠️ [merojob] 403 on ${link} – skipping.`);
                    continue;
                }
                console.error(`    ❌ [merojob] Error scraping ${link}:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};
