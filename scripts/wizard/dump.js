// scripts/wizard/dump.js
// Structured DOM inspection. Runs inside page.evaluate; returns plain
// JSON (no live DOM references) so it can be stringified into the prompt.
//
// What it collects:
//   - jsonLdTypes    — every @type found in <script type="application/ld+json">
//   - anchorGroups   — anchors grouped by href pattern
//   - pagination     — rel=next, "Next" text, ?page=N, Load more button
//   - categoryChips  — anchors/elements that look like category/tag chips
//   - cardGroups     — repeating DOM groups (tag+class) that could be cards
//   - bodySnippet    — first 300 chars of visible text

const { extractFieldEvidence } = require('./fieldEvidence');

// ---------- trimmed raw HTML for prompt ----------
// The structural dump + field evidence give the LLM heuristics. They're
// often wrong (card candidates match <script> tags, detail-link pattern
// matches every nav anchor, sample detail page is Facebook). Real HTML
// doesn't have that failure mode — the LLM sees actual structure and
// writes selectors against it.
//
// Trimmed aggressively to fit prompt budget: no scripts, no styles, no
// comments, no inline event handlers, collapsed whitespace. Structure
// (tags, classes, ids, text content) preserved.
function trimHtmlForPrompt(html, maxBytes) {
    maxBytes = maxBytes || 40000;
    let s = String(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '<!-- svg -->');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/\s+style="[^"]*"/gi, '');
    s = s.replace(/\s+on\w+="[^"]*"/gi, '');
    s = s.replace(/\s+data-(?:src|srcset|bg)="[^"]*"/gi, '');
    s = s.replace(/\s+/g, ' ');
    s = s.trim();
    if (s.length > maxBytes) {
        s = s.slice(0, maxBytes) + '<!-- truncated at ' + maxBytes + ' chars -->';
    }
    return s;
}

// Chrome-tag detector. If a "card wrapper" selector is actually HTML
// chrome, don't dump its outerHTML — it's noise.
const CHROME_TAG_RE = /^(script|link|meta|style|noscript|svg|path|head|html)$/i;
// Bare tag with no class/id/attribute/pseudo (e.g. "div", "li"). Such a selector matches far
// more than the card group it came from, so callers must not trust it on its own.
function isGenericSelector(sel) {
    return Boolean(sel) && !/[.#\[:]/.test(String(sel));
}

function isChromeSelector(sel) {
    if (!sel) return true;
    const tag = String(sel).split(/[.#\[]/)[0].trim().toLowerCase();
    return CHROME_TAG_RE.test(tag);
}

// ---------- size-aware HTML fitting with feedback ----------
// Instead of blindly stripping or capping, walk a progressive removal
// ladder and stop as soon as the payload fits the budget. Report what
// was removed so failures are diagnosable.
//
// The ladder:
//   1. Garbage: scripts, styles, svgs, comments, data URIs, event
//      handlers, inline styles. Nothing here is ever useful for a
//      selector decision.
//   2. Whitespace collapse. Pure noise reduction.
//   3. Semantic chrome: <header>, <footer>, <nav>, <aside>, aria-hidden.
//      Often removable, occasionally contains a company name we care about.
//   4. Cookie/newsletter/modal blocks -- pure junk.
//   5. If still over: truncate at the byte boundary with a visible marker.
//
// For each step, we log the byte delta. Callers get a report they can
// print or audit so a site that keeps hitting truncation is visible.
function fitHtmlToBudget(html, budgetBytes, label) {
    if (!html) return { html: null, removed: [], originalSize: 0, finalSize: 0 };
    const originalSize = html.length;
    let current = String(html);
    const removed = [];

    const tryStrip = (step, re) => {
        if (current.length <= budgetBytes) return;
        const before = current.length;
        current = current.replace(re, '');
        if (current.length < before) {
            removed.push({ step, delta: before - current.length });
        }
    };

    // Pass 1: pure garbage
    tryStrip('scripts', /<script[\s\S]*?<\/script>/gi);
    tryStrip('styles', /<style[\s\S]*?<\/style>/gi);
    tryStrip('noscript', /<noscript[\s\S]*?<\/noscript>/gi);
    tryStrip('svg', /<svg[\s\S]*?<\/svg>/gi);
    tryStrip('comments', /<!--[\s\S]*?-->/g);
    tryStrip('inline-styles', /\s+style="[^"]*"/gi);
    tryStrip('event-handlers', /\s+on\w+="[^"]*"/gi);
    tryStrip('data-uris', /data:[^"')\s>]+/g);

    // Pass 2: whitespace
    tryStrip('whitespace-collapse', /\s{2,}/g);

    // Pass 3: semantic chrome
    tryStrip('header', /<header[\s\S]*?<\/header>/gi);
    tryStrip('footer', /<footer[\s\S]*?<\/footer>/gi);
    tryStrip('nav', /<nav[\s\S]*?<\/nav>/gi);
    tryStrip('aside', /<aside[\s\S]*?<\/aside>/gi);

    // Pass 4: junk blocks
    tryStrip('cookie-blocks', /<div[^>]*class="[^"]*(?:cookie|gdpr|newsletter|modal|dropdown)[^"]*"[\s\S]*?<\/div>/gi);
    tryStrip('aria-hidden', /<div[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/div>/gi);

    // Pass 5: truncate if still over
    let truncated = false;
    if (current.length > budgetBytes) {
        const cut = current.slice(0, budgetBytes);
        removed.push({ step: 'truncated', delta: current.length - budgetBytes });
        current = cut + '\n<!-- truncated: budget=' + budgetBytes + ' -->';
        truncated = true;
    }

    return {
        html: current,
        removed,
        originalSize,
        finalSize: current.length,
        truncated,
        label
    };
}

async function dumpCardHtml(page, cardSelector, anchorHrefs) {
    if (!cardSelector || isChromeSelector(cardSelector)) return null;
    try {
        const html = await page.evaluate((sel, hrefs, isGeneric) => {
            let els;
            try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { return null; }
            const SKIP = 'form, header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
            let best = null;
            for (const cand of els) {
                if (cand.closest(SKIP)) continue;
                const parent = cand.parentElement;
                if (!parent) continue;
                let sibs = 0;
                for (const c of parent.children) { if (c.matches(sel)) sibs++; }
                if (sibs < 3) continue;
                if ((cand.textContent || '').trim().length < 40) continue;
                // Generic selector ("div"): only accept an element that holds one of the card
                // group's own hrefs, so a layout div with more siblings cannot win.
                if (isGeneric && hrefs && hrefs.length) {
                    let own = false;
                    const links = cand.matches('a[href]') ? [cand] : [];
                    for (const a of cand.querySelectorAll('a[href]')) links.push(a);
                    for (const a of links) {
                        try {
                            const u = new URL(a.getAttribute('href'), window.location.href);
                            if (hrefs.indexOf(u.pathname + u.search) !== -1) { own = true; break; }
                        } catch (e) { /* unresolvable href */ }
                    }
                    if (!own) continue;
                }
                if (!best || sibs > best.sibs) best = { el: cand, sibs };
            }
            return best ? best.el.outerHTML : null;
        }, cardSelector, Array.isArray(anchorHrefs) ? anchorHrefs : [], isGenericSelector(cardSelector));
        if (!html) return null;
        // Budget: 40KB. A real job card should be under 20KB; if it's
        // bigger, the selector matched something too broad (whole page).
        // Feedback report will show truncated=true in that case.
        return fitHtmlToBudget(html, 40000, 'rawCardHtml');
    } catch (e) {
        return null;
    }
}

async function dumpDetailHtml(page, bodySelector) {
    try {
        const html = await page.evaluate((sel) => {
            let el;
            // Prefer specific body selector when it isn't a generic container
            if (sel && !/^(script|link|meta|style|body|html|main|article|div\.container|div\.wrapper)$/i.test(sel)) {
                try { el = document.querySelector(sel); } catch (e) { el = null; }
            }
            if (!el) el = document.querySelector('main') || document.querySelector('article') || document.body;
            return el ? el.outerHTML : null;
        }, bodySelector);
        if (!html) return null;
        return fitHtmlToBudget(html, 55000, 'rawDetailHtml');
    } catch (e) {
        return null;
    }
}

async function dumpFallbackContentHtml(page) {
    try {
        const html = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            const dropSels = 'header, footer, nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"], noscript, svg, script, style';
            const drop = clone.querySelectorAll(dropSels);
            for (const c of drop) { if (c.parentNode) c.parentNode.removeChild(c); }
            const candidates = clone.querySelectorAll('section, article, main, div');
            let best = null, bestLen = 0;
            for (const c of candidates) {
                const len = (c.textContent || '').trim().length;
                if (len > bestLen && len < 500000) { best = c; bestLen = len; }
            }
            return (best || clone).outerHTML;
        });
        if (!html) return null;
        // If picked block is tiny, it means the largest child is still
        // small (page probably SPA / iframe / chrome-heavy). Fall back to
        // the whole stripped body so the LLM at least sees SOMETHING.
        if (html.length < 3000) {
            const fullBody = await page.evaluate(() => {
                const clone = document.body.cloneNode(true);
                const dropSels = 'header, footer, nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"], noscript, svg, script, style';
                const drop = clone.querySelectorAll(dropSels);
                for (const c of drop) { if (c.parentNode) c.parentNode.removeChild(c); }
                return clone.outerHTML;
            });
            if (fullBody && fullBody.length > html.length) {
                return fitHtmlToBudget(fullBody, 40000, 'rawCardHtml-fallback-fullbody');
            }
        }
        return fitHtmlToBudget(html, 40000, 'rawCardHtml-fallback');
    } catch (e) {
        return null;
    }
}

// Job-signal check on rawCardHtml. A card dump that contains ZERO
// role-ish tokens is probably site chrome (a nav, hero, or footer that
// slipped past chrome-strip) or the wrong DOM block entirely. Flag it so
// the caller can decide whether to trust the HTML.
const JOB_SIGNAL_RE = /\b(?:job|career|role|position|opening|apply|vacancy|hiring|recruit)\b/i;
function scoreCardHtml(html) {
    if (!html || typeof html !== 'string') return { hasSignal: false, hits: 0 };
    // Count distinct role-ish token hits (capped at 20 for perf)
    const re = new RegExp(JOB_SIGNAL_RE.source, 'gi');
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null && seen.size < 20) {
        seen.add(m[0].toLowerCase());
    }
    return { hasSignal: seen.size > 0, hits: seen.size };
}

async function dumpListingPage(page) {
    const structural = await page.evaluate(() => {
        // SVG elements expose className as SVGAnimatedString — coerce to string.
        // Named `clsStr` (not `cls`) so it can't collide with local variables
        // in the loops below.
        const clsStr = (el) => {
            if (!el) return '';
            const c = el.className;
            if (typeof c === 'string') return c;
            if (c && c.baseVal !== undefined) return String(c.baseVal || '');
            return '';
        };

        // ---- JSON-LD types ----
        const jsonLdTypes = [];
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const parsed = JSON.parse(script.textContent);
                const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const n of nodes) {
                    if (n && n['@type']) {
                        jsonLdTypes.push(Array.isArray(n['@type']) ? n['@type'][0] : n['@type']);
                    }
                }
            } catch (e) { /* ignore malformed */ }
        }

        // ---- Anchor groups by href pattern ----
        const patternOf = (href) => {
            try {
                const u = new URL(href, window.location.origin);
                return u.pathname.replace(/\/[0-9a-f-]{6,}/gi, '/<id>').replace(/\/\d+/g, '/<n>');
            } catch (e) { return null; }
        };
        const anchorMap = new Map();
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) continue;
            if (/^\/(login|register|signin|signup|about|contact|privacy|terms)/i.test(href)) continue;
            const pattern = patternOf(href);
            if (!pattern) continue;
            if (!anchorMap.has(pattern)) anchorMap.set(pattern, []);
            // Absolutize href. Raw getAttribute('href') returns relative
            // paths for site-relative links (`/career/foo`). Downstream
            // page.goto() rejects relative URLs with "Cannot navigate to
            // invalid URL" -- silently failing the entire detail dump.
            // Absolutize once here so every consumer (runWizardPrompt's
            // page.goto, prompt evidence, diagnose) gets a usable URL.
            let absoluteHref = href;
            try { absoluteHref = new URL(href, window.location.origin).href; } catch (e) { /* keep raw */ }
            anchorMap.get(pattern).push({
                href: absoluteHref,
                text: (a.textContent || '').trim().slice(0, 60),
                className: clsStr(a).slice(0, 60)
            });
        }
        const anchorGroups = Array.from(anchorMap.entries())
            .filter(([, items]) => items.length >= 3)
            .map(([pattern, items]) => ({
                pattern,
                count: items.length,
                samples: items.slice(0, 3).map((i) => ({ href: i.href.slice(0, 200), text: i.text, cls: i.className }))
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        // ---- Pagination ----
        const hasNextRel = Boolean(document.querySelector('a[rel="next"]'));
        const nextByText = Array.from(document.querySelectorAll('a, button'))
            .find((el) => /^(next|›|»)$/i.test((el.textContent || '').trim())) || null;
        const pageParamAnchors = Array.from(document.querySelectorAll('a[href*="?page="], a[href*="/page/"]'));
        const loadMoreBtn = Array.from(document.querySelectorAll('button'))
            .find((b) => /^load more$/i.test((b.textContent || '').trim()) && !b.disabled) || null;
        const pagination = {
            hasNextRel,
            nextByText: nextByText ? { tag: nextByText.tagName, text: nextByText.textContent.trim().slice(0, 20) } : null,
            pageParamCount: pageParamAnchors.length,
            pageParamSamples: pageParamAnchors.slice(0, 3).map((a) => a.getAttribute('href').slice(0, 120)),
            hasLoadMore: Boolean(loadMoreBtn)
        };

        // ---- Category chips ----
        const chipCandidates = Array.from(document.querySelectorAll(
            'a, span, div[class*="chip"], div[class*="pill"], div[class*="tag"], div[class*="badge"], li[class*="chip"]'
        )).filter((el) => {
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length > 40 || txt.length < 2) return false;
            if (/^\d+$/.test(txt)) return false;
            const href = el.getAttribute && el.getAttribute('href');
            if (href && href.length > 100) return false;
            return true;
        }).slice(0, 30);

        const categoryChips = chipCandidates
            .filter((el) => {
                const className = clsStr(el);
                const href = el.getAttribute && el.getAttribute('href');
                return href || /chip|pill|tag|badge|category|label/i.test(className);
            })
            .slice(0, 10)
            .map((el) => ({
                tag: el.tagName,
                cls: clsStr(el).slice(0, 60),
                text: (el.textContent || '').trim().slice(0, 40),
                href: el.getAttribute && el.getAttribute('href') ? el.getAttribute('href').slice(0, 100) : null
            }));

        // ---- Card groups ----
        // Walk the DOM looking for parents whose children share tag+class.
        const cardGroups = [];
        for (const parent of document.querySelectorAll('*')) {
            const children = Array.from(parent.children);
            if (children.length < 3) continue;
            const buckets = new Map();
            for (const child of children) {
                const childCls = clsStr(child).trim().slice(0, 80);
                const key = child.tagName + '|' + childCls;
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(child);
            }
            for (const [key, group] of buckets) {
                if (group.length < 3) continue;
                // Skip nav-like groups (pure links with no heading inside)
                if (/^(A|LI)\|/i.test(key) && !group.some((e) => e.querySelector && e.querySelector('h1,h2,h3,h4'))) continue;
                const tag = key.split('|')[0];
                const keyCls = key.split('|')[1];
                // Same CSS-escaping rule as cardCandidates above. This
                // selector feeds the wizard prompt and report output, so
                // an invalid selector here would propagate into LLM prompts
                // too.
                const selector = tag.toLowerCase() + (keyCls
                    ? '.' + keyCls.split(/\s+/).filter(Boolean).map((c) => CSS.escape(c)).join('.')
                    : '');
                cardGroups.push({ selector, count: group.length, sampleHtml: group[0].outerHTML.slice(0, 500) });
            }
        }
        const seenSelectors = new Set();
        const cards = cardGroups
            .filter((g) => { if (seenSelectors.has(g.selector)) return false; seenSelectors.add(g.selector); return true; })
            .filter((g) => g.count >= 3 && g.count <= 200)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        const bodySnippet = (document.body.innerText || '').slice(0, 300);

        // ============ REAL card + detail-link detection ============
        // The `cardGroups` and `anchorGroups` fields above are heuristic
        // signals that misfire on real sites -- `cardGroups.selector` shows
        // `link`/`script`/`meta` (head elements), and `anchorGroups.pattern`
        // shows `/` (all root-level links). Those are useless for template
        // design. The two fields below implement a stricter heuristic:
        // - cardCandidates: only body elements, only groups whose children
        //   contain a heading OR a link OR an image (real job-card shapes)
        // - detailLinkCandidates: only paths with depth >= 2, only ones that
        //   aren't nav/listing/category links
        //
        // These are the signals batch templates consume. When they're empty
        // for a site, that site routes to LLM fallback -- we don't guess.

        const SKIP_TAGS = new Set(['HEAD', 'SCRIPT', 'LINK', 'META', 'STYLE', 'NOSCRIPT', 'BR']);
        const bodyEl = document.body;
        const cardCandidates = [];
        if (bodyEl) {
            for (const parent of bodyEl.querySelectorAll('*')) {
                if (SKIP_TAGS.has(parent.tagName)) continue;
                const children = Array.from(parent.children).filter((c) => !SKIP_TAGS.has(c.tagName));
                if (children.length < 3) continue;
                const buckets = new Map();
                for (const child of children) {
                    const cls = clsStr(child).trim().slice(0, 80);
                    const key = child.tagName + '|' + cls;
                    if (!buckets.has(key)) buckets.set(key, []);
                    buckets.get(key).push(child);
                }
                for (const [key, group] of buckets) {
                    if (group.length < 3) continue;
                    let hasHeading = false, hasLink = false, hasImage = false;
                    const childSamples = [];
                    for (const child of group) {
                        if (child.querySelector('h1,h2,h3,h4,h5,h6')) hasHeading = true;
                        if (child.querySelector('a[href]')) hasLink = true;
                        if (child.querySelector('img')) hasImage = true;
                        if (childSamples.length < 2) {
                            const h = child.querySelector('h1,h2,h3,h4,h5,h6');
                            childSamples.push(h ? h.textContent.trim().slice(0, 80) : '');
                        }
                    }
                    if (!hasHeading && !hasLink && !hasImage) continue;
                    const score = (hasHeading ? 2 : 0) + (hasLink ? 2 : 0) + (hasImage ? 1 : 0);
                    if (score < 2) continue;
                    const tag = key.split('|')[0];
                    // The bucket key above truncates classes at 80 chars, so key.split('|')[1] can end
                    // mid-token (".rou") and match nothing. Grouping stays as is; the selector is built
                    // from whole class tokens present on EVERY child of the group.
                    const keyCls = clsStr(group[0]).split(/\s+/).filter(Boolean)
                        .filter((tok) => group.every((g) => clsStr(g).split(/\s+/).indexOf(tok) !== -1))
                        .join(' ');
                    // Class names with CSS-special chars (Tailwind's sm:, md:,
                    // hover:, opacity's /, arbitrary values' []) must be escaped
                    // in selectors or querySelectorAll throws "not a valid
                    // selector". CSS.escape handles all of them correctly --
                    // sm:p-7 becomes sm\\:p-7.
                    const selector = tag.toLowerCase() + (keyCls
                        ? '.' + keyCls.split(/\s+/).filter(Boolean).map((c) => CSS.escape(c)).join('.')
                        : '');
                    // Job-ish content check (group-level, kept for back-
                    // compat). High false-positive rate on its own.
                    const sampleText = group.map((c) => (c.innerText || '').toLowerCase()).join(' ').slice(0, 2000);
                    const JOB_WORDS = ['apply', 'opening', 'position', 'vacancy', 'hiring', 'job description', 'responsibilit', 'qualification', 'requirements', 'full time', 'part time', 'intern', 'salary', 'experience', 'deadline', 'candidate', 'role', 'employment'];
                    const hasJobishContent = JOB_WORDS.some((w) => sampleText.includes(w));

                    // jobTitleRatio: the strong signal. Fraction of this
                    // group's children whose own heading (h1-h6) contains
                    // a job-role word. Real job-card groups: 0.8-1.0.
                    // Culture/values/product/testimonial groups: 0.
                    const JOB_ROLE_WORDS = [
                        'engineer', 'developer', 'designer', 'manager', 'analyst',
                        'specialist', 'officer', 'executive', 'coordinator',
                        'consultant', 'architect', 'administrator', 'assistant',
                        'associate', 'director', 'lead', 'head of', 'intern',
                        'internship', 'trainee', 'apprentice', 'technician',
                        'programmer', 'scientist', 'researcher', 'accountant',
                        'sales', 'marketing', 'writer', 'editor', 'recruiter',
                        'support', 'operations', 'supervisor', 'clerk',
                        'representative', 'advisor', 'strategist', 'producer',
                        'artist', 'illustrator', 'qa', 'tester', 'devops',
                        'sde', 'cto', 'ceo', 'cfo', 'vp '
                    ];
                    let childHeadingCount = 0;
                    let childJobHeadingCount = 0;
                    for (const child of group) {
                        const h = child.querySelector('h1, h2, h3, h4, h5, h6');
                        if (!h) continue;
                        const txt = (h.textContent || '').toLowerCase().trim();
                        if (!txt) continue;
                        childHeadingCount++;
                        if (JOB_ROLE_WORDS.some((w) => txt.includes(w))) childJobHeadingCount++;
                    }
                    const jobTitleRatio = childHeadingCount > 0 ? childJobHeadingCount / childHeadingCount : 0;

                    // Wrapper vs. real-card discriminator: average child text
                    // length. Real job cards are 100-1500 chars (one job
                    // title + brief description). Wrapper sections are 3000+
                    // chars (contain the entire section's content including
                    // nested cards). A section wrapper whose childSamples are
                    // ["Our Culture", "Open Internship Positions"] averages
                    // ~5000 chars. A real card group whose childSamples are
                    // ["Frontend Developer", "Backend Developer"] averages
                    // ~500 chars.
                    const childTextLengths = group.map((c) => (c.innerText || '').trim().length);
                    const avgChildTextLength = childTextLengths.reduce((a, b) => a + b, 0) / childTextLengths.length;
                    const isLikelyWrapper = avgChildTextLength > 2500;

                    // Section-header check: a job card's heading is a title
                    // like "Frontend Developer"; a wrapper section's "heading"
                    // is a category word like "Our Culture". Filter the latter.
                    const SECTION_HEADER_PREFIX = /^(our|the|why|what|how|about|meet|features?|benefits?|culture|perks|values|mission|vision|contact)\b/i;
                    const sectionHeaderCount = childSamples.filter((s) => SECTION_HEADER_PREFIX.test(s || '')).length;
                    const looksLikeSectionWrapper = isLikelyWrapper || (sectionHeaderCount >= Math.max(1, Math.floor(group.length * 0.5)));

                    cardCandidates.push({
                        selector, count: group.length,
                        childTag: tag, childClass: keyCls.slice(0, 80),
                        hasHeading, hasLink, hasImage, score,
                        hasJobishContent,
                        jobTitleRatio: Math.round(jobTitleRatio * 100) / 100,
                        childHeadingCount,
                        childJobHeadingCount,
                        avgChildTextLength: Math.round(avgChildTextLength),
                        looksLikeSectionWrapper,
                        childSamples,
                        hrefs: (() => {
                            const out = [];
                            const seen = new Set();
                            const add = (a) => {
                                if (out.length >= 60) return;
                                const raw = a.getAttribute('href');
                                if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return;
                                let u;
                                try { u = new URL(raw, window.location.href); } catch (e) { return; }
                                const key = u.pathname + u.search;
                                if (seen.has(key)) return;
                                seen.add(key);
                                out.push(key);
                            };
                            for (const child of group) {
                                if (child.tagName === 'A' && child.hasAttribute('href')) add(child);
                                for (const a of child.querySelectorAll('a[href]')) add(a);
                            }
                            return out;
                        })(),
                        sampleHtml: group[0].outerHTML.slice(0, 300)
                    });
                }
            }
        }
        const seenCardSel = new Set();
        const sortedCards = cardCandidates
            .filter((c) => { if (seenCardSel.has(c.selector)) return false; seenCardSel.add(c.selector); return true; })
            .filter((c) => c.count >= 3 && c.count <= 300)
            .sort((a, b) => {
                // Primary: jobTitleRatio. The single strongest signal.
                // A culture group at 0 loses to a real job group at 0.6
                // regardless of count.
                if (b.jobTitleRatio !== a.jobTitleRatio) return b.jobTitleRatio - a.jobTitleRatio;
                const aRank = (a.hasJobishContent && !a.looksLikeSectionWrapper) ? 2 : (a.hasJobishContent ? 1 : 0);
                const bRank = (b.hasJobishContent && !b.looksLikeSectionWrapper) ? 2 : (b.hasJobishContent ? 1 : 0);
                if (bRank !== aRank) return bRank - aRank;
                const aCardSized = a.avgChildTextLength >= 100 && a.avgChildTextLength <= 1500 ? 1 : 0;
                const bCardSized = b.avgChildTextLength >= 100 && b.avgChildTextLength <= 1500 ? 1 : 0;
                if (bCardSized !== aCardSized) return bCardSized - aCardSized;
                if (b.score !== a.score) return b.score - a.score;
                return b.count - a.count;
            })
            .slice(0, 5);

        // Real detail links: path depth >= 2, not nav/listing/category.
        const NON_DETAIL_PREFIX = /^\/(?:category|tag|page|search|filter|about|contact|privacy|terms|login|signup|register|blog|news|events?\/category)\b/i;
        const detailLinkBuckets = new Map();
        for (const a of document.querySelectorAll('a[href]')) {
            const raw = a.getAttribute('href');
            if (!raw || raw === '#' || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) continue;
            let abs;
            try { abs = new URL(raw, window.location.origin); } catch (e) { continue; }
            if (abs.origin !== window.location.origin) continue;
            const pathname = abs.pathname;
            if (!pathname || pathname === '/') continue;
            const segments = pathname.split('/').filter(Boolean);
            if (segments.length < 2) continue;
            if (NON_DETAIL_PREFIX.test(pathname)) continue;
            const pattern = '/' + segments.map((seg) => {
                if (/^\d+$/.test(seg)) return '<id>';
                if (/^[0-9a-f]{8,}$/i.test(seg)) return '<id>';
                if (/^[0-9a-f-]{20,}$/i.test(seg)) return '<id>';
                return seg;
            }).join('/') + (pathname.endsWith('/') ? '/' : '');
            if (!detailLinkBuckets.has(pattern)) detailLinkBuckets.set(pattern, []);
            detailLinkBuckets.get(pattern).push({ href: abs.href, text: (a.textContent || '').trim().slice(0, 80) });
        }
        const detailLinkCandidates = Array.from(detailLinkBuckets.entries())
            .filter(([, items]) => items.length >= 2)
            .map(([pattern, items]) => ({ pattern, count: items.length, samples: items.slice(0, 3) }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);

        return {
            url: window.location.href,
            title: document.title,
            jsonLdTypes: [...new Set(jsonLdTypes)],
            anchorGroups,
            pagination,
            categoryChips,
            cardGroups: cards,
            bodySnippet,
            // New, real signals. These are what templates consume.
            cardCandidates: sortedCards,
            detailLinkCandidates
        };
    });

    // Field evidence runs on the NODE side -- extractFieldEvidence calls
    // page.evaluate internally, so it cannot be invoked from within the
    // browser context above. Runs immediately after the structural dump
    // so both see the same DOM state.
    let fieldEvidence = null;
    try {
        fieldEvidence = await extractFieldEvidence(page);
    } catch (e) { /* best-effort; prompt renders placeholder if null */ }

    // Bug 5: appearsInCards is computed Node-side from each card's own hrefs.
    if (Array.isArray(structural.detailLinkCandidates)) {
        structural.detailLinkCandidates = structural.detailLinkCandidates
            .map((c) => {
                const sampleHrefs = (c.samples || []).map((s) => s.href);
                return {
                    pattern: c.pattern,
                    count: c.count,
                    samples: c.samples,
                    appearsInCards: appearsInCards(structural.cardCandidates, sampleHrefs)
                };
            })
            .sort((a, b) => (b.appearsInCards ? 1 : 0) - (a.appearsInCards ? 1 : 0) || b.count - a.count)
            .slice(0, 5);
    }
    // Trim verbose fields BEFORE the dump reaches the prompt. The
    // structural dump carries anchorGroups (hundreds of entries),
    // cardCandidates with full sample arrays, jsonLdSamples with HTML
    // content — all 50KB+ of JSON noise. Keep orientation signal only;
    // the raw HTML section (below) carries the actual structure.
    const trimmed = { ...structural };
    if (Array.isArray(trimmed.anchorGroups)) {
        trimmed.anchorGroups = trimmed.anchorGroups.slice(0, 10).map((g) => ({
            pattern: g.pattern, count: g.count
        }));
    }
    // Only slice array length. Preserve full item shape because generate.js
    // reads fields like .href / .selector / .samples off [0]. Reshaping to
    // {key,count} crashes generate at pick-sample-detail-link time.
    if (Array.isArray(trimmed.anchorGroups)) {
        trimmed.anchorGroups = trimmed.anchorGroups.slice(0, 10);
    }
    if (Array.isArray(trimmed.cardCandidates)) {
        trimmed.cardCandidates = trimmed.cardCandidates.slice(0, 5);
    }
    if (Array.isArray(trimmed.detailLinkCandidates)) {
        trimmed.detailLinkCandidates = trimmed.detailLinkCandidates.slice(0, 5);
    }
    if (Array.isArray(trimmed.cardGroups)) {
        trimmed.cardGroups = trimmed.cardGroups.slice(0, 3);
    }
    if (Array.isArray(trimmed.categoryChips)) {
        trimmed.categoryChips = trimmed.categoryChips.slice(0, 10);
    }

    let rawCardHtml = null;
    try {
        const topCard = (structural.cardCandidates && structural.cardCandidates[0])
            || (structural.cardGroups && structural.cardGroups[0]);
        if (topCard && topCard.selector && !isChromeSelector(topCard.selector)) {
            rawCardHtml = await dumpCardHtml(page, topCard.selector, topCard.hrefs);
        }
        // Fallback fires when the card selector matched something tiny
        // (a wrapper div, an icon, a broken class). 3000B is the floor
        // below which the "card" HTML is definitely not a real job card.
        if (!rawCardHtml || !rawCardHtml.html) {
            const fallback = await dumpFallbackContentHtml(page);
            if (fallback && fallback.html && fallback.html.length > (rawCardHtml ? (rawCardHtml.html || '').length : 0)) {
                rawCardHtml = fallback;
            }
        }
    } catch (e) { /* best-effort */ }

    const cardScore = rawCardHtml && rawCardHtml.html ? scoreCardHtml(rawCardHtml.html) : { hasSignal: false, hits: 0 };
    if (rawCardHtml && rawCardHtml.html && !cardScore.hasSignal) {
        console.warn(`   \u26a0\ufe0f [dump] rawCardHtml has no job-signal tokens (${rawCardHtml.html.length}B, hits=${cardScore.hits}) -- likely wrong element`);
        rawCardHtml.qualityWarning = 'no_job_signal';
    } else if (rawCardHtml && rawCardHtml.html) {
        rawCardHtml.jobSignalHits = cardScore.hits;
    }

    // Weak-signal flag: no candidates, or the top one is a bare tag with weak job-title
    // evidence. 0.3 matches the jobTitleRatio threshold used elsewhere in the pipeline.
    const top0 = (structural.cardCandidates || [])[0];
    const cardCandidatesWeak = !top0 || (isGenericSelector(top0.selector) && !(top0.jobTitleRatio >= 0.3));

    return { ...trimmed, fieldEvidence, rawCardHtml, cardCandidatesWeak };
}

async function dumpDetailPage(page) {
    const structural = await page.evaluate(() => {
        const clsStr = (el) => {
            if (!el) return '';
            const c = el.className;
            if (typeof c === 'string') return c;
            if (c && c.baseVal !== undefined) return String(c.baseVal || '');
            return '';
        };
        const getText = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : null);

        // ---- JSON-LD samples ----
        const jsonLdSamples = [];
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const parsed = JSON.parse(script.textContent);
                const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const n of nodes) {
                    if (n && n['@type']) {
                        jsonLdSamples.push({
                            type: Array.isArray(n['@type']) ? n['@type'][0] : n['@type'],
                            keys: Object.keys(n).slice(0, 20),
                            name: n.name ? String(n.name).slice(0, 80) : null,
                            startDate: n.startDate || null,
                            description: n.description ? String(n.description).slice(0, 100) : null,
                            image: Array.isArray(n.image) ? n.image[0] : (n.image ? String(n.image).slice(0, 100) : null),
                            location: (n.location && (n.location.name || (n.location.address && n.location.address.streetAddress))) || null
                        });
                    }
                }
            } catch (e) { /* ignore malformed */ }
        }

        // ---- Headings ----
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
            .slice(0, 10)
            .map((h) => ({ tag: h.tagName, cls: clsStr(h).slice(0, 60), text: getText(h).slice(0, 100) }));

        // ---- Description candidate (longest leaf-ish text block) ----
        let descCandidate = null;
        let descLen = 0;
        for (const el of document.querySelectorAll('div, section, article, p')) {
            const childBigBlocks = Array.from(el.children).filter((c) => (c.textContent || '').length > 100).length;
            if (childBigBlocks > 3) continue;
            const len = (el.textContent || '').trim().length;
            if (len > descLen && len < 5000) {
                descLen = len;
                descCandidate = el;
            }
        }
        let descriptionSelector = null;
        if (descCandidate) {
            const tag = descCandidate.tagName.toLowerCase();
            const parts = clsStr(descCandidate).split(/\s+/).filter(Boolean);
            descriptionSelector = tag + (parts.length ? '.' + parts.join('.') : '');
        }

        // ---- Images ----
        const images = Array.from(document.querySelectorAll('img[src]'))
            .filter((img) => {
                const src = img.getAttribute('src') || '';
                const alt = img.alt || '';
                const className = clsStr(img);
                if (!src.startsWith('http') && !src.startsWith('/')) return false;
                if (/logo|icon|avatar|favicon/i.test(src + ' ' + className + ' ' + alt)) return false;
                return true;
            })
            .slice(0, 3)
            .map((img) => ({ src: (img.currentSrc || img.getAttribute('src') || '').slice(0, 150), alt: (img.alt || '').slice(0, 60) }));

        // ---- data-* attribute hints ----
        const dataAttrs = new Set();
        for (const el of document.querySelectorAll('[data-start], [data-date], [data-time], [data-price], [data-location], [data-organizer]')) {
            Object.keys(el.dataset).forEach((k) => dataAttrs.add(k));
        }

        // ============ MAIN CONTENT HEURISTIC ============
        // The fields above are heuristic placeholders: headings[0] may be a
        // nav item, descriptionSelector may be a wrapper div, images may
        // include the logo. This heuristic scores candidates properly:
        // - title: an h1/h2 not inside nav/header/footer, with >= 15 chars
        // - description: longest non-chrome text block (100-8000 chars)
        // - image: first non-logo, non-icon img without tiny dimensions
        // Consumers that want reliable title/desc/image use these fields.
        const isInChrome = (el) => {
            let p = el;
            while (p && p !== document.body) {
                if (p.tagName === 'NAV' || p.tagName === 'HEADER' || p.tagName === 'FOOTER') return true;
                if (p.getAttribute && p.getAttribute('role') === 'navigation') return true;
                p = p.parentElement;
            }
            return false;
        };

        const scoredTitles = Array.from(document.querySelectorAll('h1, h2'))
            .filter((h) => !isInChrome(h))
            .map((el) => {
                const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
                const score = (text.length >= 15 ? 10 : 0) + (el.tagName === 'H1' ? 5 : 0);
                return { tag: el.tagName, cls: clsStr(el).slice(0, 60), text, score };
            })
            .filter((t) => t.text.length > 0)
            .sort((a, b) => b.score - a.score);
        const bestTitle = scoredTitles[0] || null;

        let bestDesc = null;
        for (const el of document.querySelectorAll('article, section, main, div')) {
            if (isInChrome(el)) continue;
            const childBigBlocks = Array.from(el.children).filter((c) => (c.textContent || '').length > 100).length;
            if (childBigBlocks > 3) continue;
            const len = (el.textContent || '').trim().length;
            if (len >= 100 && len <= 8000 && (!bestDesc || len > bestDesc.len)) {
                bestDesc = { el, len };
            }
        }
        let mainDescSelector = null;
        if (bestDesc) {
            const tag = bestDesc.el.tagName.toLowerCase();
            const parts = clsStr(bestDesc.el).split(/\s+/).filter(Boolean);
            mainDescSelector = tag + (parts.length ? '.' + parts.join('.') : '');
        }

        const significantImg = Array.from(document.querySelectorAll('img[src]')).find((img) => {
            const src = img.getAttribute('src') || '';
            const alt = (img.alt || '').toLowerCase();
            const cls = clsStr(img).toLowerCase();
            if (/logo|icon|avatar|favicon|sprite/i.test(src + ' ' + alt + ' ' + cls)) return false;
            if (!src.startsWith('http') && !src.startsWith('/')) return false;
            const w = parseInt(img.getAttribute('width') || '0', 10);
            const h = parseInt(img.getAttribute('height') || '0', 10);
            if ((w > 0 && w < 100) || (h > 0 && h < 100)) return false;
            return true;
        });

        const mainContentHeuristic = {
            titleTag: bestTitle ? bestTitle.tag : null,
            titleClass: bestTitle ? bestTitle.cls : null,
            titleText: bestTitle ? bestTitle.text.slice(0, 120) : null,
            descriptionSelector: mainDescSelector,
            descriptionTextLength: bestDesc ? bestDesc.len : 0,
            imageSrc: significantImg ? (significantImg.currentSrc || significantImg.getAttribute('src') || null) : null,
            imageAlt: significantImg ? (significantImg.alt || '').slice(0, 80) : null
        };

        return {
            url: window.location.href,
            title: document.title,
            jsonLdSamples,
            headings,
            descriptionSelector,
            descriptionSampleLength: descLen,
            images,
            dataAttributeHints: [...dataAttrs].slice(0, 10),
            // New, real signals. Consumers that want reliable fields use these.
            mainContentHeuristic
        };
    });

    let fieldEvidence = null;
    try {
        fieldEvidence = await extractFieldEvidence(page);
    } catch (e) { /* best-effort */ }

    const trimmed = { ...structural };
    if (Array.isArray(trimmed.jsonLdSamples)) {
        trimmed.jsonLdSamples = trimmed.jsonLdSamples.slice(0, 2).map((j) => ({
            type: j.type || j['@type'] || null
        }));
    }
    if (Array.isArray(trimmed.headings)) {
        trimmed.headings = trimmed.headings.slice(0, 6);
    }
    if (Array.isArray(trimmed.images)) {
        trimmed.images = trimmed.images.slice(0, 5);
    }
    if (Array.isArray(trimmed.dataAttributeHints)) {
        trimmed.dataAttributeHints = trimmed.dataAttributeHints.slice(0, 10);
    }

    let rawDetailHtml = null;
    try {
        const bodySel = (structural.mainContentHeuristic && structural.mainContentHeuristic.descriptionSelector) || null;
        rawDetailHtml = await dumpDetailHtml(page, bodySel);
    } catch (e) { /* best-effort */ }

    return { ...trimmed, fieldEvidence, rawDetailHtml };
}

// Bug 5 helpers (pure Node). Function declarations hoist, so listing order is irrelevant.
function hrefMatches(cardHref, candidateHref) {
    const norm = (h) => {
        const u = new URL(String(h), 'http://dump.invalid');
        let p = u.pathname;
        while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
        return p + u.search;
    };
    try {
        if (typeof cardHref !== 'string' || typeof candidateHref !== 'string') return false;
        return norm(cardHref) === norm(candidateHref);
    } catch (e) {
        return false;
    }
}

function appearsInCards(cards, candidateHrefs) {
    if (!Array.isArray(cards) || !Array.isArray(candidateHrefs) || candidateHrefs.length === 0) return false;
    return cards.some((card) => {
        if (!card) return false;
        if (Array.isArray(card.hrefs)) {
            return card.hrefs.some((ch) => candidateHrefs.some((cand) => hrefMatches(ch, cand)));
        }
        if (typeof card.sampleHtml !== 'string') return false;
        const lastSegs = candidateHrefs.map((h) => {
            const parts = String(h).split('/');
            return parts[parts.length - 1] || parts[parts.length - 2] || '';
        });
        return lastSegs.some((seg) => seg && card.sampleHtml.includes(seg));
    });
}

module.exports = { dumpListingPage, dumpDetailPage, dumpCardHtml, hrefMatches, appearsInCards };
