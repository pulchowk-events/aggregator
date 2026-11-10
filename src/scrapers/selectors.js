// src/scrapers/selectors.js
// Fallback-chain selectors for DOM extraction.
//
// Every "grab a field" call in a source plugin goes through pickOne() or
// pickAll(), which try a LIST of selectors in order and return the first
// non-empty match. If a selector OTHER than the first one wins, that's a
// drift signal — the site changed, the source's primary selector is stale,
// and a maintainer should look. The warning is emitted here so every
// source gets it for free.
//
// Why fallback chains at all: single-selector scraping is brittle. When
// KataJaam changed a card class on 2026-11-10, one selector failed
// silently for a whole run (0 events, no error). A chain lets the source
// keep working through minor class changes while still surfacing drift via
// `fellBack: true` in the return value.
//
// Two entry points:
//   pickOne(page, selectors, opts) -> { value, selector, index, fellBack }
//   pickAll(page, selectors, opts) -> { values, count, selector, index, fellBack }
//
// `opts.attr` selects what to read from the element:
//   'textContent' (default) | 'href' | 'src' | any attribute name

async function pickOne(page, selectors, options = {}) {
    const { label = 'value', attr = 'textContent' } = options;
    if (!Array.isArray(selectors) || selectors.length === 0) {
        throw new Error(`pickOne(${label}): empty selector list`);
    }

    const result = await page.evaluate(({ sels, attr }) => {
        for (let i = 0; i < sels.length; i++) {
            const el = document.querySelector(sels[i]);
            if (!el) continue;
            const v = attr === 'textContent' ? el.textContent.trim()
                    : attr === 'href'        ? el.href
                    : attr === 'src'         ? el.src
                    : el.getAttribute(attr);
            if (v) return { value: v, index: i, selector: sels[i] };
        }
        return { value: null, index: -1, selector: null };
    }, { sels: selectors, attr });

    const fellBack = result.index > 0;
    if (fellBack) {
        console.warn(`⚠️ [selectors] ${label}: primary "${selectors[0]}" matched nothing, fell back to "${selectors[result.index]}" — update the primary when convenient.`);
    }
    return { ...result, fellBack };
}

async function pickAll(page, selectors, options = {}) {
    const { label = 'items', attr = 'href' } = options;
    if (!Array.isArray(selectors) || selectors.length === 0) {
        throw new Error(`pickAll(${label}): empty selector list`);
    }

    const result = await page.evaluate(({ sels, attr }) => {
        for (let i = 0; i < sels.length; i++) {
            const els = Array.from(document.querySelectorAll(sels[i]));
            if (els.length > 0) {
                const values = els.map((el) => {
                    if (attr === 'href') return el.href;
                    if (attr === 'src') return el.src;
                    if (attr === 'textContent') return el.textContent.trim();
                    return el.getAttribute(attr);
                }).filter(Boolean);
                return { values, count: values.length, index: i, selector: sels[i] };
            }
        }
        return { values: [], count: 0, index: -1, selector: null };
    }, { sels: selectors, attr });

    const fellBack = result.index > 0;
    if (fellBack) {
        console.warn(`⚠️ [selectors] ${label}: primary "${selectors[0]}" matched nothing, fell back to "${selectors[result.index]}" — update the primary when convenient.`);
    }
    return { ...result, fellBack };
}

module.exports = { pickOne, pickAll };
