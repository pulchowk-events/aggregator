// src/scrapers/extractors/jobs/nimble-2.js
//
// VERDICT: CAREERS_PAGE
//
// Corrected wizard assumptions:
// - Site type: EMPTY_CAREERS_LISTING, not single-page-cards.
// - div.row: page layout wrappers, NOT job cards.
// - The three div.row matches contain no actual job titles or vacancies.
// - div.container (1408 chars) is a page-level wrapper, not a job description.
// - The authoritative role-body region confirms:
//   h4.text-info.no-vacancy:
//   "No any vacancy available at the moment, please keep in touch for future vacancies."
// - No JSON-LD JobPosting data.
// - No per-job detail routes.
// - Employer: Nimble Infosys Pvt. Ltd. (og:title).
//
// Current result: ATS_EMPTY. Do not generate jobs from marketing content.

const { delay, loadPage } = require('../../page');
const { safeDiscovered } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const NIMBLE_URL = 'https://career.nimble.com.np/';
const COMPANY = 'Nimble Infosys Pvt. Ltd.';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load listing page ----
        try {
            meta.pagesVisited++;

            await loadPage(page, NIMBLE_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(500);
        } catch (err) {
            console.warn(
                '[nimble-2] failed to load careers page: ' + err.message
            );

            meta.listingHits = 0;
            safeDiscovered(progress, 0);

            return { items, meta };
        }

        // ---- Detect blocking ----
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;

                safeDiscovered(progress, 0);

                return { items, meta };
            }
        } catch (err) {
            // Diagnostics are best-effort.
        }

        // ---- Inspect actual listing content ----
        const result = await page.evaluate(() => {
            const clean = (value) => {
                return value
                    ? value.replace(/\s+/g, ' ').trim()
                    : '';
            };

            const bodyText = clean(
                document.body ? document.body.innerText : ''
            );

            const vacancyElement = document.querySelector(
                'h4.text-info.no-vacancy'
            );

            const vacancyText = clean(
                vacancyElement ? vacancyElement.innerText : ''
            );

            const emptyPatterns = [
                /no any vacancy available/i,
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /check back soon/i,
                /there are no (open|current)/i,
                /sorry, no positions available/i
            ];

            const isEmpty = emptyPatterns.some((pattern) => {
                return pattern.test(vacancyText || bodyText);
            });

            // Confirm employer from site metadata.
            const ogTitle = document.querySelector(
                'meta[property="og:title"]'
            );

            const employer = clean(
                ogTitle ? ogTitle.getAttribute('content') : ''
            ) || clean(document.title);

            // Check for actual role-shaped content, not layout rows.
            const hasRoleContent = Array.from(
                document.querySelectorAll(
                    '.nim-emp-tab-list .tab-content h1, ' +
                    '.nim-emp-tab-list .tab-content h2, ' +
                    '.nim-emp-tab-list .tab-content h3'
                )
            ).some((heading) => {
                const text = clean(heading.innerText);

                return text.length >= 3 &&
                    !/no any vacancy|no vacancies|no openings/i.test(text);
            });

            return {
                isEmpty,
                vacancyText,
                employer,
                hasRoleContent,
                bodySnippet: bodyText.slice(0, 500)
            };
        });

        // ---- Empty careers page ----
        if (result.isEmpty && !result.hasRoleContent) {
            meta.atsEmpty = true;
            meta.listingHits = 0;

            safeDiscovered(progress, 0);

            console.log(
                '  [nimble-2] extracted 0 (no current vacancies)'
            );

            return { items, meta };
        }

        // No verified job-card structure exists in the supplied DOM
        // evidence. Avoid interpreting marketing content or navigation
        // elements as job listings.
        meta.listingHits = 0;

        safeDiscovered(progress, 0);

        console.log(
            '  [nimble-2] extracted 0 (no verified job-card structure)'
        );

        return { items, meta };
    }
};