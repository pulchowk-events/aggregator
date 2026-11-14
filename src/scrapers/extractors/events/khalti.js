// Site-specific extractor. See ../README.md for the contract.
// Ported to contract form: browser lifecycle + retry + sanitize now live
// in sources/_orchestrate.js, so this file is ONLY the DOM work.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');

const KHALTI_EVENTS_URL = 'https://events.khalti.com/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('🕷️ [khalti] Scraping Khalti events...');
        meta.pagesVisited++;
        await page.goto(KHALTI_EVENTS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('div.css-pm9gn2', { timeout: 15000 });
        await delay(6000); // let images finish loading

        const events = await page.evaluate(() => {
            const eventCards = document.querySelectorAll('div.css-0 > div.css-waslwm');
            return Array.from(eventCards).map((card, index) => {
                try {
                    const titleEl = card.querySelector('h2.chakra-heading');
                    const title = titleEl ? titleEl.textContent.trim() : null;

                    const imageContainer = card.querySelector('div.css-11at2as');
                    let image = null;
                    if (imageContainer) {
                        const imgEl = imageContainer.querySelector('img');
                        if (imgEl) image = window.__resolveImageSrc(imgEl);
                    }

                    const descriptionEl = card.querySelector('p:not(.chakra-text), [class*="description"]');
                    const description = descriptionEl ? descriptionEl.textContent.trim() : null;

                    const linkEl = card.querySelector('div.css-heb237[href]');
                    let eventUrl = null;
                    if (linkEl) {
                        const href = linkEl.getAttribute('href');
                        eventUrl = href ? new URL(href, window.location.origin).href : null;
                    }

                    const dateEl = card.querySelector('.chakra-stack.css-s4n4cn p.chakra-text');
                    const date = dateEl ? dateEl.textContent.trim() : null;

                    const locationEls = card.querySelectorAll('.chakra-stack.css-s4n4cn');
                    let location = null;
                    if (locationEls.length > 1) {
                        const locationText = locationEls[1].textContent.trim();
                        if (!locationText.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
                            location = locationText;
                        }
                    }

                    const priceEl = card.querySelector('.css-1ryl886 p.chakra-text');
                    const price = priceEl ? priceEl.textContent.trim() : null;

                    const badgeEl = card.querySelector('.chakra-badge p.chakra-text');
                    const status = badgeEl ? badgeEl.textContent.trim() : null;

                    const buttonEl = card.querySelector('.chakra-button');
                    let organizer = 'Khalti';
                    if (buttonEl && buttonEl.textContent && !buttonEl.textContent.includes('Buy') && !buttonEl.textContent.includes('Ticket')) {
                        organizer = buttonEl.textContent.trim();
                    }

                    let attendanceMode = 'in-person';
                    if (location && location.toLowerCase().includes('online')) attendanceMode = 'online';
                    else if (location && location.toLowerCase().includes('hybrid')) attendanceMode = 'hybrid';

                    if (title) {
                        return {
                            id: `khalti-${index}-${Date.now()}`,
                            title, description, image, location, date, price, status,
                            url: eventUrl,
                            registrationUrl: eventUrl,
                            organizer,
                            source: 'khalti',
                            attendanceMode,
                            featured: status && status.toLowerCase().includes('special')
                        };
                    }
                    return null;
                } catch (error) {
                    console.error('Error parsing Khalti event card:', error);
                    return null;
                }
            }).filter((event) => event && event.title);
        });

        safeDiscovered(progress, events.length);
        safeUnitDone(progress, events.length);
        meta.listingHits = events.length;

        return { items: events, meta };
    }
};
