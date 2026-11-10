// Private extractor — gitignored. See ../README.md for the contract.
// Structural shape: EACEA catalogue (Engineering OR IT facet, paginated) ->
// per-project EACEA detail page.
//
// Two links per listing card, use only one to navigate:
//   .ecl-content-block__title a -> the programme's OWN external site.
//     Never visited. Only surfaced as "Relevant link" in the description.
//   link inside .ecl-content-block__description -> EACEA project detail.
//     THIS is the one navigated into; its URL becomes `url` and
//     `registrationUrl`.
//
// deadlineRaw is DELIBERATELY null: no application deadline exists on
// this page ("Start date" / "End date" are the project's overall
// duration, not a student deadline). buildScholarship's title/description
// fallback is skipped for this source via SOURCES_WITHOUT_DEADLINE_FALLBACK.
//
// fundingType / degreeLevel are HARDCODED EMJMD facts (every catalogue
// entry is a fully-funded Erasmus Mundus Joint Master), not scraped.
// "EU Grant" is the total consortium grant, not a per-student amount —
// deliberately not mapped into fundingAmount.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { auditLog } = require('../../../core/auditLogger');
const { buildScholarship, appendMoreInfoLink, looksOutdatedByYear } = require('../../scholarships');

const ERASMUS_MUNDUS_BASE_URL = 'https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en';
const ERASMUS_MUNDUS_QUERY = 'f%5B0%5D=studies_for_emjmd_studies_for_emjmd_project%3A23&f%5B1%5D=studies_for_emjmd_studies_for_emjmd_project%3A904';
const ERASMUS_MUNDUS_MAX_PAGES = 10;

async function harvestListing(page) {
    return page.evaluate(() => {
        const getText = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : null);
        // 2026-11-10: card wrapper migrated from .ecl-content-item-block__item
                // to <article class="ecl-card">. Everything inside (title, description,
                // external link, detail link) is unchanged. Fallback to old class in
                // case EACEA ever reverts.
                const cards = document.querySelectorAll('article.ecl-card, .ecl-content-item-block__item');
        return Array.from(cards).map((card) => {
            const titleLinkEl = card.querySelector('.ecl-content-block__title a');
            const labelEl = titleLinkEl ? titleLinkEl.querySelector('.ecl-link__label') : null;
            const title = labelEl ? getText(labelEl) : (titleLinkEl ? getText(titleLinkEl) : null);
            const siteUrl = titleLinkEl ? titleLinkEl.href : null;

            const descP = card.querySelector('.ecl-content-block__description p');
            let descLabel = null;
            let detailUrl = null;
            if (descP) {
                const detailLinkEl = descP.querySelector('a');
                detailUrl = detailLinkEl ? detailLinkEl.href : null;
                const clone = descP.cloneNode(true);
                const linkClone = clone.querySelector('a');
                if (linkClone) linkClone.remove();
                descLabel = clone.textContent.replace(/\s+/g, ' ').trim();
            }

            return { title, siteUrl, descLabel, detailUrl };
        }).filter((x) => x.title && x.detailUrl);
    });
}

async function scrapeDetail(page) {
    return page.evaluate(() => {
        const getText = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : null);

        const findFlexField = (label) => {
            const boxes = document.querySelectorAll('.valor-icon');
            for (const box of boxes) {
                const labelP = box.querySelector('p');
                if (labelP && labelP.textContent.trim().toLowerCase() === label.toLowerCase()) {
                    const b = box.querySelector('b');
                    if (b) return getText(b);
                }
            }
            return null;
        };

        const findCalendarField = (label) => {
            const calendarUl = document.querySelector('ul.valor-icon.calendar');
            if (!calendarUl) return null;
            const lis = calendarUl.querySelectorAll('li');
            for (const li of lis) {
                const p = li.querySelector('p');
                if (p && p.textContent.trim().toLowerCase().startsWith(label.toLowerCase())) {
                    const b = p.querySelector('b');
                    return b ? getText(b) : null;
                }
            }
            return null;
        };

        const websiteAnchor = document.querySelector('.valor-icon.website a');
        const websiteUrl = websiteAnchor ? websiteAnchor.href : null;

        // The outer `.card-content.summary` wrapper ALSO matches the bare
        // `.summary` class and contains the eTranslation widget's language
        // picker + disclaimer text. A bare querySelector('.summary') would
        // grab the OUTER wrapper first — use the child combinator to target
        // the inner summary div, with last-matching fallback.
        const summaryEl = document.querySelector('.card-content.summary > div.summary')
            || Array.from(document.querySelectorAll('div.summary')).pop()
            || null;
        const description = summaryEl ? summaryEl.textContent.trim() : null;

        let countriesText = null;
        const countriesContainer = document.querySelector('.card-content.participant-countries');
        if (countriesContainer) {
            const clone = countriesContainer.cloneNode(true);
            const heading = clone.querySelector('h2');
            if (heading) heading.remove();
            countriesText = clone.textContent.replace(/\s+/g, ' ').trim();
        }

        let coordinatorName = null;
        const coordinatorContainer = document.querySelector('.card-content.coordinator');
        if (coordinatorContainer) {
            const bTags = coordinatorContainer.querySelectorAll('b');
            coordinatorName = bTags.length > 0 ? getText(bTags[0]) : null;
        }

        // Partner universities — strip trailing flag-emoji + country from
        // each header. A regional-indicator flag is 2 code points in the
        // U+1F1E6–U+1F1FF range.
        const partnerNames = Array.from(document.querySelectorAll('.collapsible-header')).map((h) => {
            let text = h.textContent.trim();
            text = text.replace(/[\u{1F1E6}-\u{1F1FF}]{2}[\s\S]*$/u, '').trim();
            return text;
        }).filter(Boolean);

        return {
            description,
            status: findFlexField('Project Status'),
            actionType: findFlexField('Action Type'),
            startDate: findCalendarField('Start date'),
            endDate: findCalendarField('End date'),
            websiteUrl,
            countriesText,
            coordinatorName,
            partnerNames
        };
    });
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        for (let pageNum = 0; pageNum < ERASMUS_MUNDUS_MAX_PAGES; pageNum++) {
            const pageUrl = `${ERASMUS_MUNDUS_BASE_URL}?${ERASMUS_MUNDUS_QUERY}&page=${pageNum}`;

            try {
                meta.pagesVisited++;
                await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                await delay(1000 + Math.random() * 800);
            } catch (error) {
                console.warn(`⚠️ [erasmusmundus] failed to load page ${pageNum}: ${error.message}`);
                break;
            }

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [erasmusmundus] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            let cards = [];
            try {
                await page.waitForSelector('article.ecl-card, .ecl-content-item-block__item', { timeout: 12000 });
                cards = await harvestListing(page);
            } catch (e) {
                console.log(`ℹ️ [erasmusmundus] no cards on page ${pageNum} — stopping.`);
                break;
            }

            if (cards.length === 0) {
                console.log(`ℹ️ [erasmusmundus] page ${pageNum} returned 0 cards — stopping.`);
                break;
            }

            const eligible = cards.filter((c) => !looksOutdatedByYear(`${c.title || ''} ${c.descLabel || ''}`));
            const skipped = cards.length - eligible.length;
            if (skipped > 0) {
                console.log(`ℹ️ [erasmusmundus] skipping ${skipped} older-looking project(s) on page ${pageNum}.`);
            }

            meta.listingHits += eligible.length;
            console.log(`✅ [erasmusmundus] ${eligible.length} eligible project(s) on page ${pageNum}`);
            safeDiscovered(progress, eligible.length);

            for (const card of eligible) {
                try {
                    console.log(`  📄 [erasmusmundus] Scraping project: ${card.title}`);
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await page.goto(card.detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await delay(700 + Math.random() * 600);

                    const raw = await scrapeDetail(page);

                    if (raw.actionType && !/joint master/i.test(raw.actionType)) {
                        auditLog('erasmus_mundus_sanity_check', `"${card.title}": scraped Action Type ("${raw.actionType}") doesn't look like an EMJMD — hardcoded constants still applied, informational only`, {
                            title: card.title, detailUrl: card.detailUrl, scrapedActionType: raw.actionType
                        }, 'warn');
                    }

                    const moreInfoUrl = card.siteUrl || raw.websiteUrl || null;
                    const description = appendMoreInfoLink(raw.description, moreInfoUrl);

                    const tags = (raw.countriesText || '')
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .concat(['Erasmus Mundus'])
                        .concat((raw.partnerNames || []).slice(0, 3))
                        .filter(Boolean)
                        .slice(0, 6);

                    items.push(buildScholarship({
                        title: card.title,
                        description,
                        provider: raw.coordinatorName,
                        deadlineRaw: null,
                        fundingType: 'Erasmus Mundus Joint Master Degree (Fully Funded)',
                        fundingAmount: null,
                        degreeLevel: "Master's (EMJMD)",
                        fieldOfStudy: 'Engineering & Information Technology',
                        image: null,
                        tags,
                        source: 'erasmusmundus',
                        url: card.detailUrl
                    }));
                    console.log(`    ✅ [erasmusmundus] Scraped: ${card.title}`);
                } catch (error) {
                    console.error(`    ❌ [erasmusmundus] Error scraping project "${card.title}":`, error.message);
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        return { items, meta };
    }
};
