// Site-specific extractor for Black Tech career page.
// VERDICT: CAREERS_PAGE — listing URL exposes 9 distinct /career/<uuid>
// detail links with role titles and metadata; per-link navigation required.
//
// Structural shape: single listing page -> per-job detail page.
// Listing cards expose: title, level, employment type, work mode,
// experience, openings count, apply-by deadline. Description body
// (if present) lives on the per-job detail page.
//
// Listing card structure (verified from raw HTML):
//   <a class="group flex flex-col gap-3 bg-black ..." href="/career/<uuid>">
//     <p class="text-white/80 font-medium text-2xl">{title}</p>
//     <p>{|Mid Level}</p>
//     Apply now | Onsite | Full Time | 2 yrs | 1 - Openings | Deadline: YYYY-MM-DD
//   </a>
//
// Wizard correction: cardCandidates reports `script` (27) and
// `div.relative.flex.rounded-xl...` (12) as the top card wrappers — both
// are HTML chrome (analytics scripts + decorative hero panels). The real
// job card is the <a class="group ..."> anchor, evidenced by
// detailLinkCandidates `/career/<id>` count 9 == listing count.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const BLACKTECH_BASE_URL = 'https://www.blacktech.com.np';
const BLACKTECH_LISTING_URL = 'https://www.blacktech.com.np/career';
const COMPANY_NAME = 'Black Tech Pvt. Ltd.';

const EVIDENCE = {
    company: 'site name "Black Tech" from page title "Black Tech. - Career" + LinkedIn slug "black-tech-pvt-ltd"',
    locationAbsent: [
        'site publishes only Onsite/Remote mode flag; no city/region',
        'on card or detail page; searched [class*="location"],',
        '[class*="city"], [class*="address"]'
    ].join(' '),
    descriptionAbsent: [
        'searched [class*="job-description"], [class*="role-body"],',
        '[class*="job-detail"], article, .prose, main p — no role',
        'body region on detail page'
    ].join(' '),
    employmentAbsent: [
        'no Full Time/Part Time/Contract/Internship label on',
        'listing card or detail page'
    ].join(' '),
    deadlineAbsent: 'no "Deadline:" label on listing card or detail page',
    imageAbsent: 'no per-job image on detail page; listing card has no img',
    salaryAbsent: 'no Salary/Compensation/Stipend label on card or detail page',
    levelAbsent: 'no Senior/Mid/Junior Level label on card or detail page'
};

const SEL = {
    listingCard: [
        'a.group[href^="/career/"]',
        'a.group.flex.flex-col[href^="/career/"]',
        'a[class*="group"][href^="/career/"]'
    ],
    detailTitle: [
        'h1',
        'h1.text-2xl',
        'h1.text-3xl',
        'h1.font-medium',
        'h1.font-bold',
        'h1[class*="text-white"]',
        'p.text-white\\/80.font-medium.text-2xl',
        'p.font-medium.text-2xl',
        'p.text-2xl'
    ]
};

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];

        // ----- 1. Load listing page -----
        try {
            meta.pagesVisited++;
            await loadPage(page, BLACKTECH_LISTING_URL);
            await delay(Math.random() * 1000 + 500);
        } catch (error) {
            console.warn(`[blacktech] listing load failed: ${error.message}`);
            return { items, meta };
        }

        // ----- 2. Block / captcha check on first load -----
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[blacktech] listing looks blocked`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // ----- 3. Empty-state check -----
        const emptyState = await page.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();
            const phrases = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'no any vacancy',
                'we are always hiring',
                'always on the lookout',
                'not hiring',
                'check back soon',
                'no positions available'
            ];
            return phrases.some((p) => text.includes(p));
        });
        if (emptyState) {
            meta.atsEmpty = true;
            return { items, meta };
        }

        // ----- 4. Wait for cards, harvest listing links -----
        try {
            await page.waitForSelector('a[href^="/career/"]', { timeout: 10000 });
        } catch (e) {
            console.warn(`[blacktech] no career anchors on listing`);
            return { items, meta };
        }

        const listing = await pickAll(page, SEL.listingCard, { label: 'listing' });
        meta.listingHits += listing.count;

        const cardHrefs = (listing.values || [])
            .filter((href) => {
                if (!href) return false;
                try {
                    const u = new URL(href, BLACKTECH_BASE_URL);
                    return /\/career\/[a-f0-9-]{36}$/i.test(u.pathname);
                } catch (_) {
                    return false;
                }
            })
            .map((href) => {
                try {
                    return new URL(href, BLACKTECH_BASE_URL).href;
                } catch (_) {
                    return href;
                }
            })
            .filter((v, i, arr) => arr.indexOf(v) === i);

        safeDiscovered(progress, cardHrefs.length);

        // ----- 5. Parse metadata from each listing card (fallback layer) -----
        const cardMeta = await page.evaluate(() => {
            const out = {};
            const cards = Array.from(document.querySelectorAll('a[href^="/career/"]'))
                .filter((a) => {
                    const h = a.getAttribute('href') || '';
                    return /\/career\/[a-f0-9-]{36}$/i.test(h);
                });
            for (const card of cards) {
                const href = card.getAttribute('href') || '';
                let key;
                try {
                    key = new URL(href, window.location.origin).href;
                } catch (_) {
                    key = href;
                }
                const rawText = card.innerText || card.textContent || '';
                const lines = rawText.split('\n').map((s) => s.trim()).filter(Boolean);

                const skipSet = new Set([
                    'Apply now', 'Onsite', 'Remote', 'Hybrid',
                    'Full Time', 'Part Time', 'Contract', 'Internship'
                ]);

                // Title: first non-CTA / non-meta line
                let title = null;
                for (const line of lines) {
                    const cleaned = line.replace(/^\|\s*/, '').trim();
                    if (!cleaned) continue;
                    if (skipSet.has(cleaned)) continue;
                    if (/^\d+\s*-\s*Openings$/i.test(cleaned)) continue;
                    if (/^Deadline:/i.test(cleaned)) continue;
                    if (/^\d+\s*\+?\s*yrs?$/i.test(cleaned)) continue;
                    if (/^(Senior|Mid|Junior|Entry|Lead)\s*Level$/i.test(cleaned)) continue;
                    title = cleaned;
                    break;
                }

                // Level: "Mid Level" — sometimes prefixed with |
                let level = null;
                const levelMatch = rawText.match(
                    /\|?\s*(Senior|Mid|Junior|Entry|Lead)\s*Level/i
                );
                if (levelMatch) {
                    const word = levelMatch[1].toLowerCase();
                    level = word.charAt(0).toUpperCase() + word.slice(1) + ' Level';
                }

                // Employment type
                let employmentType = null;
                const empMatch = rawText.match(
                    /\b(Full Time|Part Time|Contract|Internship)\b/
                );
                if (empMatch) employmentType = empMatch[1];

                // Attendance mode
                let attendanceMode = null;
                const modeMatch = rawText.match(/\b(Onsite|Remote|Hybrid)\b/);
                if (modeMatch) attendanceMode = modeMatch[1];

                // Openings count
                let openings = null;
                const openMatch = rawText.match(/(\d+)\s*-\s*Openings/i);
                if (openMatch) openings = openMatch[1];

                // Experience
                let experience = null;
                const expMatch = rawText.match(/(\d+\s*\+?\s*yrs?)/i);
                if (expMatch) experience = expMatch[1].trim();

                // Deadline (apply-by)
                let deadline = null;
                const deadlineMatch = rawText.match(
                    /Deadline:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i
                );
                if (deadlineMatch) deadline = deadlineMatch[1];

                out[key] = {
                    title, level, employmentType, attendanceMode,
                    openings, experience, deadline
                };
            }
            return out;
        });

        // ----- 6. Per-link detail extraction -----
        for (const href of cardHrefs) {
            const detailUrl = href.startsWith('http')
                ? href
                : BLACKTECH_BASE_URL + href;
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, detailUrl);
                await delay(Math.random() * 1000 + 500);

                // Detail-page title (with listing-card fallback)
                const titleResult = await pickOne(
                    page,
                    SEL.detailTitle,
                    { label: `detail title (${detailUrl})` }
                );
                let title = titleResult.value;
                if (!title && cardMeta[detailUrl]) {
                    title = cardMeta[detailUrl].title;
                }
                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                // One-shot detail-page extraction
                const extras = await page.evaluate(() => {
                    const getText = (el) => (el
                        ? (el.innerText || el.textContent || '').trim()
                        : null);

                    // ---- description ----
                    let description = null;
                    const descCandidates = [
                        '[class*="job-description"]',
                        '[class*="role-description"]',
                        '[class*="role-body"]',
                        '[class*="job-detail"]',
                        '[class*="job-body"]',
                        '[class*="description-body"]',
                        'article',
                        '.prose',
                        '[class*="markdown"]',
                        'main'
                    ];
                    const genericSet = new Set([
                        'article', '.prose', '[class*="markdown"]', 'main'
                    ]);
                    for (const sel of descCandidates) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const txt = getText(el);
                        if (!txt) continue;
                        if (txt.length < 80) continue;
                        const head = txt.slice(0, 100).toLowerCase();
                        if (/^(home|company|career|contact|current opening|apply now)/
                            .test(head)) continue;
                        const isGeneric = genericSet.has(sel);
                        if (isGeneric && txt.length > 4000) continue;
                        if (!isGeneric && txt.length > 6000) continue;
                        description = txt;
                        break;
                    }

                    // Fallback: collect paragraphs from main content
                    if (!description) {
                        const main = document.querySelector('main')
                            || document.body;
                        const ps = Array.from(main.querySelectorAll('p'))
                            .map((p) => getText(p))
                            .filter((t) => t && t.length > 30);
                        if (ps.length > 0) {
                            const combined = ps.slice(0, 8).join('\n\n');
                            if (combined.length > 80 && combined.length < 5000) {
                                description = combined;
                            }
                        }
                    }

                    // ---- level ----
                    let level = null;
                    const levelEl = Array.from(
                        document.querySelectorAll('p, span, div, li')
                    ).find((el) => {
                        const t = (el.textContent || '').trim();
                        return /^(Senior|Mid|Junior|Entry|Lead)\s*Level$/i
                            .test(t);
                    });
                    if (levelEl) {
                        const m = levelEl.textContent
                            .match(/(Senior|Mid|Junior|Entry|Lead)\s*Level/i);
                        if (m) level = m[0];
                    }

                    // ---- employment type ----
                    let employmentType = null;
                    const empEl = Array.from(
                        document.querySelectorAll('p, span, div, li')
                    ).find((el) => {
                        const t = (el.textContent || '').trim();
                        return ['Full Time', 'Part Time', 'Contract', 'Internship']
                            .includes(t);
                    });
                    if (empEl) employmentType = empEl.textContent.trim();

                    // ---- attendance mode ----
                    let attendanceMode = null;
                    const modeEl = Array.from(
                        document.querySelectorAll('p, span, div, li')
                    ).find((el) => {
                        const t = (el.textContent || '').trim();
                        return ['Onsite', 'Remote', 'Hybrid'].includes(t);
                    });
                    if (modeEl) attendanceMode = modeEl.textContent.trim();

                    // ---- location (city / region) ----
                    let location = null;
                    const locEl = document.querySelector(
                        '[class*="location"], [class*="city"], [class*="address"]'
                    );
                    if (locEl) {
                        const lt = getText(locEl);
                        if (lt && lt.length > 0 && lt.length < 80) location = lt;
                    }

                    // ---- openings ----
                    let openings = null;
                    const openMatch = (document.body.innerText || '').match(
                        /(\d+)\s*-\s*Openings/i
                    );
                    if (openMatch) openings = openMatch[1];

                    // ---- experience ----
                    let experience = null;
                    const expMatch = (document.body.innerText || '').match(
                        /(\d+\s*\+?\s*yrs?)/i
                    );
                    if (expMatch) experience = expMatch[1].trim();

                    // ---- deadline ----
                    let deadline = null;
                    const deadlineMatch = (document.body.innerText || '').match(
                        /Deadline:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i
                    );
                    if (deadlineMatch) deadline = deadlineMatch[1];

                    // ---- salary ----
                    let salary = null;
                    const salaryMatch = (document.body.innerText || '').match(
                        /(?:Salary|Compensation|Stipend):\s*([^\n]{1,60})/i
                    );
                    if (salaryMatch) salary = salaryMatch[1].trim().slice(0, 60);

                    // ---- image ----
                    let image = null;
                    const imgs = Array.from(document.querySelectorAll('img'));
                    const imgEl = imgs.find((img) => {
                        const alt = (img.getAttribute('alt') || '').toLowerCase();
                        const src = (img.getAttribute('src') || '').toLowerCase();
                        if (!alt) return false;
                        if (['logo', 'icon', 'avatar'].includes(alt)) return false;
                        if (src.includes('logo') || src.includes('icon')) return false;
                        const w = img.naturalWidth || img.width || 0;
                        return w >= 100;
                    });
                    if (imgEl && typeof window.__resolveImageSrc === 'function') {
                        try {
                            image = window.__resolveImageSrc(imgEl);
                        } catch (_) {
                            image = imgEl.getAttribute('src') || null;
                        }
                    }

                    // ---- labeled sections ----
                    const findLabeled = (label) => {
                        const heads = Array.from(document.querySelectorAll(
                            'h1, h2, h3, h4, h5, strong, b, p, span'
                        ));
                        for (const h of heads) {
                            const ht = (h.textContent || '').trim().toLowerCase();
                            if (!ht.includes(label.toLowerCase())) continue;
                            if (ht.length > label.length + 20) continue;
                            const sib = h.nextElementSibling;
                            if (sib) {
                                const t = getText(sib);
                                if (t && t.length > 10) return t;
                            }
                            const parent = h.parentElement;
                            if (parent && parent !== h) {
                                const inner = getText(parent);
                                const rest = inner
                                    .slice(h.textContent.length).trim();
                                if (rest && rest.length > 10) return rest;
                            }
                        }
                        return null;
                    };

                    const responsibilities = findLabeled('Responsibilities');
                    const requirements = findLabeled('Requirements');
                    const skillsRaw = findLabeled('Skills');

                    return {
                        description,
                        level,
                        employmentType,
                        attendanceMode,
                        location,
                        openings,
                        experience,
                        deadline,
                        salary,
                        image,
                        responsibilities,
                        requirements,
                        skillsRaw,
                        finalUrl: window.location.href
                    };
                });

                // Merge: detail page wins, listing card fills gaps
                const card = cardMeta[detailUrl] || {};
                const level = extras.level || card.level || null;
                const employmentType = extras.employmentType
                    || card.employmentType || null;
                const attendanceMode = extras.attendanceMode
                    || card.attendanceMode || null;
                const openings = extras.openings || card.openings || null;
                const experience = extras.experience
                    || card.experience || null;
                const applicationEndsRaw = extras.deadline
                    || card.deadline || null;
                const description = extras.description;
                const salary = extras.salary || null;
                const image = extras.image || null;
                const location = extras.location || null;

                const item = {
                    id: `blacktech-${Date.now()}-${Math.random()
                        .toString(36).substr(2, 9)}`,
                    title,
                    company: COMPANY_NAME,
                    company_status: 'extracted',
                    company_evidence: EVIDENCE.company,
                    url: extras.finalUrl || detailUrl,
                    registrationUrl: extras.finalUrl || detailUrl,
                    location,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: location ? '' : EVIDENCE.locationAbsent,
                    description,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description
                        ? ''
                        : EVIDENCE.descriptionAbsent,
                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted' : 'site_absent',
                    employmentType_evidence: employmentType
                        ? ''
                        : EVIDENCE.employmentAbsent,
                    attendanceMode,
                    applicationEndsRaw,
                    applicationEndsRaw_status: applicationEndsRaw
                        ? 'extracted' : 'site_absent',
                    applicationEndsRaw_evidence: applicationEndsRaw
                        ? ''
                        : EVIDENCE.deadlineAbsent,
                    image,
                    image_status: image ? 'extracted' : 'site_absent',
                    image_evidence: image ? '' : EVIDENCE.imageAbsent,
                    salary,
                    salary_status: salary ? 'extracted' : 'site_absent',
                    salary_evidence: salary ? '' : EVIDENCE.salaryAbsent,
                    level,
                    level_status: level ? 'extracted' : 'site_absent',
                    level_evidence: level ? '' : EVIDENCE.levelAbsent,
                    experience,
                    openings,
                    responsibilities: extras.responsibilities,
                    requirements: extras.requirements,
                    skills: extras.skillsRaw
                        ? extras.skillsRaw.split(/[,，\n]+/)
                            .map((s) => s.trim()).filter(Boolean)
                        : [],
                    tags: [],
                    source: 'blacktech'
                };

                items.push(item);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    continue;
                }
                // best-effort: continue to next link, orchestrator retries whole extract()
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [blacktech] extracted ${items.length}`);
        return { items, meta };
    }
};