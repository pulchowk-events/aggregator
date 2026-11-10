// Private extractor — gitignored. See ../README.md for the contract.
// Structural shape: virtualized /internships list (scroll + Load more / Next)
// -> per-internship detail. Mirrors the SathiJob pattern; the one
// substantive difference is the slug-based fallback for level / employment
// type / work mode — InternSathi slugs encode these (e.g.
// "...-entrylevel-fulltime-hybrid") whereas SathiJob slugs don't.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    EMPLOYMENT_TYPE_SUFFIXES,
    parseApplicationEndDate,
    sanitizeJobFields
} = require('../../jobs');

const INTERNSATHI_BASE_URL = 'https://internsathi.com';
const INTERNSATHI_LIST_URL = `${INTERNSATHI_BASE_URL}/internships`;

const SCROLL_STEP_PX = 700;
const STAGNANT_SCROLL_LIMIT = 3;
const MAX_SCROLL_STEPS_PER_LOAD = 40;
const MAX_LOAD_MORE_CLICKS = 20;

const INTERNSATHI_EMPLOYMENT_TYPE_SUFFIXES = ['Full Time', 'Part Time', 'Internship', 'Contract', 'Remote'];
const INTERNSATHI_WORK_MODE_WORDS = ['Onsite', 'On-site', 'Hybrid', 'Remote'];
const INTERNSATHI_LEVEL_WORDS = ['Entry', 'Entry Level', 'Intermediate', 'Senior'];

async function gatherLinks(page) {
    const linksMap = new Map();

    const harvestVisible = async () => {
        const rows = await page.evaluate(() => {
            const isLikelyDetailSlug = (href) => {
                const slug = (href || '').replace(/^\/internships\//, '').replace(/\/$/, '');
                return slug.split('-').length >= 3;
            };
            const anchors = Array.from(document.querySelectorAll('a[href^="/internships/"]'));
            return anchors
                .filter((a) => isLikelyDetailSlug(a.getAttribute('href')))
                .map((a) => {
                    const card = a.closest('div.relative.cursor-pointer') || a.closest('div');
                    let daysLeftText = null;
                    if (card) {
                        const candidates = Array.from(card.querySelectorAll('p'));
                        const match = candidates.find((p) => /days? left|deadline/i.test(p.textContent || ''));
                        if (match) daysLeftText = match.textContent.trim();
                    }
                    return { href: a.getAttribute('href'), daysLeftText };
                });
        });
        for (const row of rows) {
            if (row.href && !linksMap.has(row.href)) linksMap.set(row.href, { daysLeftText: row.daysLeftText });
        }
    };

    const scrollListContainer = async (deltaPx) => {
        await page.evaluate((delta) => {
            const firstRow = document.querySelector('[data-index="0"]');
            const heightWrapper = firstRow ? firstRow.parentElement : null;
            const scrollParent = heightWrapper ? heightWrapper.parentElement : null;
            if (scrollParent) scrollParent.scrollTop += delta;
            else window.scrollBy(0, delta);
        }, deltaPx);
    };

    const scrollListContainerToTop = async () => {
        await page.evaluate(() => {
            const firstRow = document.querySelector('[data-index="0"]');
            const heightWrapper = firstRow ? firstRow.parentElement : null;
            const scrollParent = heightWrapper ? heightWrapper.parentElement : null;
            if (scrollParent) scrollParent.scrollTop = 0;
            else window.scrollTo(0, 0);
        });
    };

    const clickLoadMoreOrNext = async () => page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const loadMore = btns.find((b) => (b.textContent || '').trim().toLowerCase() === 'load more' && !b.disabled);
        if (loadMore) { loadMore.click(); return true; }
        const next = btns.find((b) => {
            const t = (b.textContent || '').trim().toLowerCase();
            return (t === 'next' || t === '›' || t === '»') && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
        });
        if (next) { next.click(); return true; }
        return false;
    });

    await harvestVisible();

    for (let loadIteration = 0; loadIteration <= MAX_LOAD_MORE_CLICKS; loadIteration++) {
        let previousCount = linksMap.size;
        let stagnantRounds = 0;

        for (let step = 0; step < MAX_SCROLL_STEPS_PER_LOAD; step++) {
            await scrollListContainer(SCROLL_STEP_PX);
            await delay(350);
            await harvestVisible();

            if (linksMap.size === previousCount) {
                stagnantRounds++;
                if (stagnantRounds >= STAGNANT_SCROLL_LIMIT) break;
            } else {
                stagnantRounds = 0;
            }
            previousCount = linksMap.size;
        }

        if (loadIteration === MAX_LOAD_MORE_CLICKS) break;

        const clicked = await clickLoadMoreOrNext();
        if (!clicked) break;

        await delay(1500);
        await scrollListContainerToTop();
    }

    return Array.from(linksMap.entries()).map(([href, meta]) => ({ href, ...meta }));
}

async function scrapeDetail(page, slugFallback) {
    const raw = await page.evaluate((employmentTypeSuffixes) => {
        const getText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
        const mainCol = document.querySelector('div.w-full.flex-1') || document.body;

        const title = getText(mainCol.querySelector('h1'));
        const companyLinkEl = mainCol.querySelector('a[href^="/company/"]');
        const company = companyLinkEl ? getText(companyLinkEl) : null;
        const companyUrl = companyLinkEl ? companyLinkEl.getAttribute('href') : null;
        const logoEl = mainCol.querySelector('img[alt="logo"]');
        const companyLogoUrl = logoEl ? (logoEl.currentSrc || logoEl.src || null) : null;

        const metaP = mainCol.querySelector('p.flex.items-center.text-t-xs');
        const metaText = metaP ? getText(metaP) : '';
        let location = metaText;
        let employmentType = null;
        for (const suffix of employmentTypeSuffixes) {
            if (metaText && metaText.endsWith(suffix)) {
                employmentType = suffix;
                location = metaText.slice(0, metaText.length - suffix.length).trim();
                break;
            }
        }

        const stats = {};
        mainCol.querySelectorAll('div.grid.sm\\:grid-cols-2 > div.flex.gap-3, div.grid > div.flex.gap-3').forEach((item) => {
            const label = item.querySelector('p.text-t-xs.text-gray-400');
            const value = item.querySelector('p.font-medium');
            if (label && value) stats[getText(label)] = getText(value);
        });

        const sectionHeaders = Array.from(mainCol.querySelectorAll('p.text-base.font-medium, p.text-t-lg.font-medium'));

        const extractStructuredText = (container) => {
            if (!container) return '';
            const nodes = container.querySelectorAll('p, li');
            if (nodes.length === 0) return getText(container) || '';
            return Array.from(nodes)
                .map((n) => (n.tagName === 'LI' ? `• ${getText(n)}` : getText(n)))
                .filter(Boolean)
                .join('\n');
        };

        const findSection = (matcher) => {
            const header = sectionHeaders.find((h) => matcher((h.textContent || '').trim()));
            return header ? header.nextElementSibling : null;
        };

        const description = extractStructuredText(findSection((t) => /^(job|internship) description/i.test(t)));
        const responsibilities = extractStructuredText(findSection((t) => /^responsibilities/i.test(t)));
        const requirements = extractStructuredText(findSection((t) => /^requirements/i.test(t)));

        const skillsHeader = sectionHeaders.find((h) => /^required skills/i.test((h.textContent || '').trim()));
        const skills = skillsHeader && skillsHeader.nextElementSibling
            ? Array.from(skillsHeader.nextElementSibling.querySelectorAll('span')).map(getText).filter(Boolean)
            : [];

        let companyDescription = null;
        let companyLocation = null;
        let companyAddress = null;
        const aboutHeader = Array.from(document.querySelectorAll('p.text-t-lg.font-medium'))
            .find((p) => (p.textContent || '').trim() === 'About Company');
        if (aboutHeader) {
            const aboutContainer = aboutHeader.parentElement;
            if (aboutContainer) {
                const paras = Array.from(aboutContainer.querySelectorAll('p'));
                for (const p of paras) {
                    const t = getText(p) || '';
                    if (/^location:/i.test(t)) companyLocation = t.replace(/^location:\s*/i, '');
                    else if (/^address:/i.test(t)) companyAddress = t.replace(/^address:\s*/i, '');
                }
                const descEl = aboutContainer.querySelector('.line-clamp-2, .editor-styles');
                if (descEl) companyDescription = getText(descEl);
            }
        }

        let applicationEndsRaw = null;
        const appEndsLabel = Array.from(mainCol.querySelectorAll('p.text-t-xs.text-gray-400')).find((p) => {
            const t = (p.textContent || '').trim();
            return t === 'Application ends:' || t === 'Application deadline:';
        });
        if (appEndsLabel && appEndsLabel.nextElementSibling) {
            applicationEndsRaw = getText(appEndsLabel.nextElementSibling);
        }

        return {
            title, company, companyUrl, companyLogoUrl,
            location: location || null,
            employmentType: employmentType || null,
            salary: stats['Offered Salary'] || stats['Stipend'] || null,
            attendanceMode: stats['Location'] || null,
            experience: stats['Experience'] || null,
            level: stats['Level'] || null,
            openings: stats['Openings'] || null,
            description, responsibilities, requirements, skills,
            companyDescription, companyLocation, companyAddress, applicationEndsRaw
        };
    }, INTERNSATHI_EMPLOYMENT_TYPE_SUFFIXES);

    // Slug-based fallback — only fills gaps the page didn't fill.
    if (slugFallback) {
        const parts = slugFallback.toLowerCase().split('-');
        if (!raw.level) {
            const levelWord = INTERNSATHI_LEVEL_WORDS.find((w) =>
                parts.includes(w.toLowerCase().replace(/\s+/g, '')) ||
                slugFallback.toLowerCase().includes(w.toLowerCase().replace(/\s+/g, ''))
            );
            if (levelWord) raw.level = levelWord;
        }
        if (!raw.employmentType) {
            if (slugFallback.toLowerCase().includes('parttime')) raw.employmentType = 'Part Time';
            else if (slugFallback.toLowerCase().includes('fulltime')) raw.employmentType = 'Full Time';
        }
        if (!raw.attendanceMode) {
            const modeWord = INTERNSATHI_WORK_MODE_WORDS.find((w) =>
                slugFallback.toLowerCase().includes(w.toLowerCase().replace(/-/g, ''))
            );
            if (modeWord) raw.attendanceMode = modeWord;
        }
    }

    return raw;
}

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('🕷️ [internsathi] Scraping listing...');
        meta.pagesVisited++;
        await page.goto(INTERNSATHI_LIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2000 + Math.random() * 1500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`⚠️ [internsathi] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
            }
        } catch (e) { /* best-effort */ }

        const linkEntries = await gatherLinks(page);
        meta.listingHits = linkEntries.length;
        console.log(`✅ [internsathi] Found ${linkEntries.length} internship link(s)`);
        safeDiscovered(progress, linkEntries.length);

        const items = [];
        for (const entry of linkEntries) {
            const link = entry.href.startsWith('http') ? entry.href : `${INTERNSATHI_BASE_URL}${entry.href}`;
            const slug = entry.href.replace(/^\/internships\//, '').replace(/\/$/, '');
            try {
                console.log(`  📄 [internsathi] Scraping internship: ${link}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800 + Math.random() * 800);

                const raw = await scrapeDetail(page, slug);
                if (!raw.title) {
                    meta.detailParseFailures++;
                    console.warn(`⚠️ [internsathi] no title on ${link}`);
                    continue;
                }

                const finalJob = {
                    id: `internsathi-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: raw.title || 'Untitled Internship',
                    company: raw.company || null,
                    companyUrl: raw.companyUrl ? `${INTERNSATHI_BASE_URL}${raw.companyUrl}` : null,
                    companyLogoUrl: raw.companyLogoUrl || null,
                    location: raw.location || null,
                    employmentType: raw.employmentType || null,
                    attendanceMode: raw.attendanceMode || null,
                    salary: raw.salary || null,
                    experience: raw.experience || null,
                    level: raw.level || null,
                    openings: raw.openings || null,
                    description: raw.description || '',
                    responsibilities: raw.responsibilities || '',
                    requirements: raw.requirements || '',
                    skills: raw.skills || [],
                    companyDescription: raw.companyDescription || '',
                    companyLocation: raw.companyLocation || null,
                    companyAddress: raw.companyAddress || null,
                    applicationEndsRaw: raw.applicationEndsRaw || null,
                    applicationEndsDate: parseApplicationEndDate(raw.applicationEndsRaw),
                    daysLeftAtListTime: entry.daysLeftText || null,
                    url: link,
                    registrationUrl: link,
                    source: 'internsathi',
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(finalJob);
                items.push(finalJob);
                console.log(`    ✅ [internsathi] Scraped: ${finalJob.title}`);
                await delay(800);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`⚠️ [internsathi] 403 on ${link} – skipping.`);
                    continue;
                }
                console.error(`    ❌ [internsathi] Error scraping ${link}:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};
