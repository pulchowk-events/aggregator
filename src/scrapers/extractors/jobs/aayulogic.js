// src/scrapers/extractors/jobs/aayulogic.js
// Aayulogic careers - single-page-cards style. The site's own "View Open
// Roles" CTA targets href="#open-roles" on this same page, so every role
// lives in the in-page "#open-roles" block; no detail navigation needed.
//
// NOTE: the static evidence dump only captured nav/footer wrappers and the
// culture-FAQ accordion (the role list is client-rendered by Next.js). So
// instead of hard-coding a card class we anchor off `#open-roles` and fall
// back to job-title headings inside <main>. We deliberately skip anything
// inside header/nav/footer so CTA text like "Talk to Our Engineering Team"
// can't be mistaken for a role.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');

const CAREERS_URL = 'https://aayulogic.com/careers/';

module.exports = {
    // Optional. Runs once per item after extraction, before common sanitization.
    preprocessItem(item) {
        if (item.image) item.image = sanitizeImageUrl(item.image) || null;
        return item;
    },

    async extract(page, { progress, meta }) {
        console.log('??? [aayulogic] Scraping Aayulogic careers...');

        meta.pagesVisited++;
        await page.goto(CAREERS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Cloudflare / captcha check on the first (and only) load.
        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('[aayulogic] page looks blocked:', (state.bodySnippet || '').slice(0, 200));
            meta.looksBlocked = true;
            return { items: [], meta };
        }

        // Let the client-rendered role list hydrate.
        await delay(3000);

        // Scroll in steps so lazily-mounted cards paint.
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let y = 0;
                const step = () => {
                    window.scrollBy(0, window.innerHeight);
                    y += window.innerHeight;
                    if (y < document.body.scrollHeight && y < 20000) {
                        setTimeout(step, 120);
                    } else {
                        resolve();
                    }
                };
                step();
            });
        });

        // Bring the open-roles block into view (the site's own CTA targets it).
        await page.evaluate(() => {
            const el = document.getElementById('open-roles');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
        });
        await delay(1500);

        const raw = await page.evaluate(() => {
            const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
            const txt = (el) => (el ? clean(el.textContent) : '');
            const abs = (href) => {
                try { return href ? new URL(href, window.location.origin).href : null; }
                catch (e) { return null; }
            };

            const JOBISH = /(engineer|developer|designer|manager|analyst|intern|architect|lead|devops|qa|quality|tester|consultant|specialist|officer|associate|executive|accountant|recruiter|marketing|sales)/i;
            const CTA = /^(talk to|get in touch|send your cv|discuss your|view open|contact|about us|careers|faq)\b/i;

            // Preferred container: the "#open-roles" anchor target's section.
            const anchor = document.getElementById('open-roles');
            const scope = (anchor && (anchor.closest('section') || anchor.parentElement))
                || document.querySelector('main')
                || document.body;

            const headings = Array.from(scope.querySelectorAll('h2, h3, h4, h5'));
            const out = [];
            const seen = new Set();

            for (const h of headings) {
                const title = txt(h);
                if (!title || title.length < 3 || title.length > 140) continue;
                if (CTA.test(title)) continue;               // nav/CTA copy, not a role
                if (!JOBISH.test(title)) continue;           // not a job-ish heading
                if (h.closest('header, nav, footer')) continue;

                const key = title.toLowerCase();
                if (seen.has(key)) continue;

                // Climb to a card-ish ancestor: first one carrying a link or
                // meaningful body copy beyond the heading itself.
                let card = h.parentElement;
                let depth = 0;
                while (card && card !== scope && depth < 4) {
                    const extra = txt(card).length - title.length;
                    if (card.querySelector('a[href]') || extra > 30) break;
                    card = card.parentElement;
                    depth++;
                }
                if (!card) card = h.parentElement;

                const body = txt(card);
                // Too thin to be a role card (bare heading / nav remnant).
                if (body.length < title.length + 15) continue;

                // description: longest paragraph/list item in the card
                let description = '';
                const paras = Array.from(card.querySelectorAll('p, li'));
                for (const p of paras) {
                    const t = txt(p);
                    if (t && t.length > description.length && t.toLowerCase() !== key) {
                        description = t;
                    }
                }
                if (!description) description = clean(body.replace(title, '')).slice(0, 600);

                // apply / detail link - prefer an explicit apply/job link
                let url = null;
                let registrationUrl = null;
                const links = Array.from(card.querySelectorAll('a[href]'));
                for (const a of links) {
                    const href = a.getAttribute('href') || '';
                    if (!href || href === '#' || href.startsWith('mailto:')) continue;
                    const full = abs(href);
                    if (!full) continue;
                    if (!url) url = full;
                    const label = txt(a);
                    if (/apply|job|career|position|role/i.test(href)
                        || /apply|view role|open role|details/i.test(label)) {
                        registrationUrl = full;
                        url = full;
                        break;
                    }
                }

                // image (lazy-load aware)
                let image = null;
                const imgEl = card.querySelector('img');
                if (imgEl && typeof window.__resolveImageSrc === 'function') {
                    image = window.__resolveImageSrc(imgEl);
                }

                // location / attendance mode from the card copy
                let location = null;
                const locMatch = body.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|On-?site)\b/i);
                if (locMatch) location = locMatch[1];

                let attendanceMode = null;
                if (/remote/i.test(body)) attendanceMode = 'online';
                else if (/hybrid/i.test(body)) attendanceMode = 'hybrid';
                else if (locMatch) attendanceMode = 'in-person';

                // seniority / employment type as free-form tags when present
                const tags = [];
                const lvl = body.match(/\b(Intern|Junior|Mid[- ]?level|Senior|Lead|Principal)\b/i);
                if (lvl) tags.push(lvl[1]);
                const emp = body.match(/\b(Full[- ]?time|Part[- ]?time|Contract|Freelance)\b/i);
                if (emp) tags.push(emp[1]);

                out.push({
                    title,
                    description: description || null,
                    url,
                    registrationUrl,
                    image,
                    location,
                    attendanceMode,
                    tags
                });
                seen.add(key);
            }

            return out;
        });

        const now = Date.now();
        const items = [];

        safeDiscovered(progress, raw.length);

        for (let i = 0; i < raw.length; i++) {
            try {
                const r = raw[i];
                if (!r || !r.title) continue;

                items.push({
                    id: `aayulogic-${now}-${Math.random().toString(36).slice(2, 8)}`,
                    title: r.title,
                    description: r.description,
                    // No posted/deadline date exposed on the listing cards.
                    date: null,
                    time: null,
                    location: r.location,
                    // Jobs have no price.
                    price: null,
                    organizer: 'Aayulogic',
                    // Site exposes no explicit category; keep null.
                    category: null,
                    tags: Array.isArray(r.tags) ? r.tags : [],
                    image: r.image,
                    url: r.url || CAREERS_URL,
                    registrationUrl: r.registrationUrl || r.url || CAREERS_URL,
                    attendanceMode: r.attendanceMode,
                    company: 'Aayulogic',
                    source: 'aayulogic'
                });
            } catch (err) {
                console.error('[aayulogic] failed to build item:', err);
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;

        console.log(`? [aayulogic] extracted ${items.length} role(s)`);

        // Empty listing is valid - return cleanly, don't throw.
        return { items, meta };
    }
};