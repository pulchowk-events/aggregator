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

async function dumpListingPage(page) {
    return page.evaluate(() => {
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
                    const keyCls = key.split('|')[1];
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
                        childTag: tag, childClass: keyCls,
                        hasHeading, hasLink, hasImage, score,
                        hasJobishContent,
                        jobTitleRatio: Math.round(jobTitleRatio * 100) / 100,
                        childHeadingCount,
                        childJobHeadingCount,
                        avgChildTextLength: Math.round(avgChildTextLength),
                        looksLikeSectionWrapper,
                        childSamples,
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
            .map(([pattern, items]) => {
                // "appearsInCards" = is this href referenced inside a card's
                // own HTML? Genuine detail links appear on their card. Nav
                // links don't.
                const lastSegs = items.slice(0, 3).map((it) => {
                    const parts = it.href.split('/');
                    return parts[parts.length - 1] || parts[parts.length - 2] || '';
                });
                const appearsInCards = sortedCards.some((card) =>
                    lastSegs.some((seg) => seg && card.sampleHtml.includes(seg))
                );
                return { pattern, count: items.length, samples: items.slice(0, 3), appearsInCards };
            })
            .sort((a, b) => (b.appearsInCards ? 1 : 0) - (a.appearsInCards ? 1 : 0) || b.count - a.count)
            .slice(0, 5);

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
}

async function dumpDetailPage(page) {
    return page.evaluate(() => {
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
}

module.exports = { dumpListingPage, dumpDetailPage };
