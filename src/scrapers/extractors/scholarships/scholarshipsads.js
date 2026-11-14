// Site-specific extractor. See ../README.md for the contract.
// Structural shape: 2 category listings, first page only per category
// (page 2+ is Cloudflare-challenged, so the extractor deliberately stops
// after page 1). No per-card detail visit — the deadline, when present,
// comes from the listing card's own icon-calendar row.
//
// Deadline coverage is partial by structure, not by bug: roughly a third
// of listing cards carry an icon-calendar with a real parsed date; the
// rest ship as year-only estimates. The detail-page visit that used to
// fill this gap was dropped in 6d2f0f9 — page 2+ and detail pages are
// Cloudflare-challenged, so the round-trip cost more than the coverage it
// added. See docs/scrapers.md "Reference: the 10 current sources".

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { buildScholarship } = require('../../scholarships');

const SCHOLARSHIPSADS_CATEGORIES = [
    { key: 'engineering',        label: 'Engineering',          path: 'https://www.scholarshipsads.com/fully-funded-engineering-scholarships-for-nepalese-students' },
    { key: 'computer-science-it', label: 'Computer Science & IT', path: 'https://www.scholarshipsads.com/fully-funded-computer-science-it-scholarships-for-nepalese-students' }
];
const SCHOLARSHIPSADS_MAX_PAGES = 10;

async function harvestCards(page) {
    return page.evaluate(() => {
        // Pulls one field off a card's <li> rows by matching the icon
        // class (icon-dollor = funding, icon-place = institution,
        // icon-Bachelor2 = degree level, icon-book = field(s) of study,
        // icon-world = student type, icon-map = country). Also strips the
        // "+N More" toggle link — its hidden <span> with extra
        // comma-separated items is kept (display:none still has real
        // textContent), so nothing from a truncated list is lost.
        const findByIcon = (card, cls) => {
            const icon = card.querySelector(`i.${cls}`);
            if (!icon) return null;
            const li = icon.closest('li');
            if (!li) return null;
            const clone = li.cloneNode(true);
            const iconClone = clone.querySelector(`i.${cls}`);
            if (iconClone) iconClone.remove();
            const moreLink = clone.querySelector('a');
            if (moreLink) moreLink.remove();
            const text = clone.textContent.replace(/\s+/g, ' ').trim();
            return text || null;
        };

        const cards = document.querySelectorAll('div.scholarship-card');
        return Array.from(cards).map((card) => {
            const titleLink = card.querySelector('.sc-title a');
            const title = titleLink ? titleLink.textContent.trim() : null;
            const detailUrl = titleLink ? titleLink.href : null;

            const imgEl = card.querySelector('.sc-media img');
            const image = imgEl ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src')) : null;

            const descEl = card.querySelector('.sc-desc p') || card.querySelector('.sc-desc');
            const description = descEl ? descEl.textContent.trim() : null;

            return {
                title,
                detailUrl,
                image,
                description,
                fundingType: findByIcon(card, 'icon-dollor'),
                institution: findByIcon(card, 'icon-place'),
                degreeLevel: findByIcon(card, 'icon-Bachelor2'),
                fieldOfStudy: findByIcon(card, 'icon-book'),
                studentType: findByIcon(card, 'icon-world'),
                country: findByIcon(card, 'icon-map'),
                // Absolute deadline lives on the listing card as
                // `<i class="icon-calendar"></i> Deadline: 01 Feb 2027`.
                // This is authoritative and requires no detail-page visit.
                deadline: findByIcon(card, 'icon-calendar')
            };
        }).filter((c) => c.title);
    });
}


module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        for (const category of SCHOLARSHIPSADS_CATEGORIES) {
            for (let pageNum = 1; pageNum <= SCHOLARSHIPSADS_MAX_PAGES; pageNum++) {
                // URL construction:
            //   - Site's own pagination shows ?page=2, ?page=3, ... — no
            //     ?page=1 link anywhere. The default page (no param) IS
            //     page 1, so we deliberately skip ?page=1.
            //   - Historical bug fixed 2026-11-10: base URL used to end
            //     with ?sort=newest, so appending "?sort=newest&page=N"
            //     produced a doubled-?-URL that resolved to 0 cards.
            const pageUrl = pageNum === 1
                ? `${category.path}?sort=newest`
                : `${category.path}?sort=newest&page=${pageNum}`;
            console.log(`🕷️ [scholarshipsads] ${category.key} page ${pageNum} — ${pageUrl}`);

                try {
                    meta.pagesVisited++;
                    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                    await delay(1200 + Math.random() * 1000);
                } catch (error) {
                    console.warn(`⚠️ [scholarshipsads] failed to load ${category.key} page ${pageNum}: ${error.message}`);
                    continue;
                }

                if (meta.pagesVisited === 1) {
                    try {
                        const state = await detectPageState(page);
                        if (state.looksBlocked) {
                            meta.looksBlocked = true;
                            console.warn(`⚠️ [scholarshipsads] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                        }
                    } catch (e) { /* best-effort */ }
                }

                let cardsData = [];
                try {
                    await page.waitForSelector('div.scholarship-card', { timeout: 12000 });
                    cardsData = await harvestCards(page);
                } catch (e) {
                    // Page 2+ is Cloudflare-challenged on this site. When the
                    // URL carries the __cf_chl_rt_tk marker, it's a bot-check
                    // redirect, not DOM drift — log as info and stop this
                    // category (page 1 already gave us the newest 20 items).
                    const finalUrl = page.url();
                    const isCloudflareChallenge = /__cf_chl_rt_tk|cf_chl_opt|challenge-platform/i.test(finalUrl);
                    if (isCloudflareChallenge) {
                        console.log(`ℹ️ [scholarshipsads] ${category.key} page ${pageNum}: Cloudflare challenge (page 1 already captured, stopping this category).`);
                    } else {
                        // Real drift case — dump enough to diagnose.
                        let bodySnippet = '';
                        try {
                            bodySnippet = await page.evaluate(() => (document.body.innerText || '').slice(0, 220));
                        } catch (_) { /* ignore */ }
                        console.warn(`⚠️ [scholarshipsads] ${category.key} page ${pageNum}: no .scholarship-card found after 12s.`);
                        console.warn(`   final URL: ${finalUrl}`);
                        console.warn(`   body snippet: ${JSON.stringify(bodySnippet)}`);
                    }
                    break;
                }

                if (cardsData.length === 0) {
                    console.log(`ℹ️ [scholarshipsads] ${category.key} page ${pageNum} returned 0 cards — stopping this category.`);
                    break;
                }

                console.log(`✅ [scholarshipsads] ${category.key} page ${pageNum}: ${cardsData.length} card(s)`);
                meta.listingHits += cardsData.length;
                safeDiscovered(progress, cardsData.length);

                for (const raw of cardsData) {
                    try {
                        const tags = []
                            .concat((raw.country || '').split(',').map((s) => s.trim()).filter(Boolean))
                            .concat((raw.studentType || '').split(',').map((s) => s.trim()).filter(Boolean))
                            .concat([category.label])
                            .filter(Boolean)
                            .slice(0, 6);

                        // Deadline comes straight off the listing card. The
                        // previous design navigated to each item's detail page
                        // to find richer deadline text in body paragraphs, but
                        // Cloudflare blocked ~95% of those visits — 184/193
                        // items fell back to raw.title (year-only), producing
                        // deadlineStatus='estimated-year-only' at scale. The
                        // listing card always carries an absolute date
                        // ("Deadline: 01 Feb 2027"), so the detail visit is
                        // dropped entirely. Fast, no Cloudflare failure mode.
                        const deadlineRaw = raw.deadline || raw.title;

                        items.push(buildScholarship({
                            title: raw.title,
                            description: raw.description,
                            provider: raw.institution,
                            deadlineRaw,
                            fundingType: raw.fundingType,
                            fundingAmount: null,
                            degreeLevel: raw.degreeLevel,
                            fieldOfStudy: (raw.fieldOfStudy && raw.fieldOfStudy.toLowerCase() !== 'all subjects') ? raw.fieldOfStudy : null,
                            image: raw.image,
                            tags,
                            source: 'scholarshipsads',
                            url: raw.detailUrl
                        }));
                    } finally {
                        safeUnitDone(progress);
                    }
                }

                // The per-card lookups above navigated the page away from
                // the listing — the next loop iteration re-navigates.
            }
        }

        return { items, meta };
    }
};
