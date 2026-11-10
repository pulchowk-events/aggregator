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
            anchorMap.get(pattern).push({
                href,
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
                const selector = tag.toLowerCase() + (keyCls ? '.' + keyCls.split(/\s+/).join('.') : '');
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

        return {
            url: window.location.href,
            title: document.title,
            jsonLdTypes: [...new Set(jsonLdTypes)],
            anchorGroups,
            pagination,
            categoryChips,
            cardGroups: cards,
            bodySnippet
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

        return {
            url: window.location.href,
            title: document.title,
            jsonLdSamples,
            headings,
            descriptionSelector,
            descriptionSampleLength: descLen,
            images,
            dataAttributeHints: [...dataAttrs].slice(0, 10)
        };
    });
}

module.exports = { dumpListingPage, dumpDetailPage };
