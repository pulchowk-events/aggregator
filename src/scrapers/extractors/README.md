# Scraper extractors

Site-specific DOM extraction for each source plugin lives here. The
`<type>/<name>.js` files contain the actual CSS selectors, page-evaluate
bodies, and site-specific quirks — they are `.gitignore`d and stay local
to the deployment.

The `<type>/<name>.example.js` stubs are committed. They exist so:

1. The loader always resolves a module (no crash-on-missing-file).
2. The plugin contract is documented by working code.
3. A forker can `cp khalti.example.js khalti.js` and implement the body.

## Contract

```js
module.exports = {
    // Optional. Runs once per item after extraction, before common
    // sanitization. Return the (possibly mutated) item.
    preprocessItem(item) { return item; },

    // Required. Does ALL the browser work for this source and returns
    // { items, meta }. The orchestrator handles browser lifecycle, retry,
    // common sanitization, and diagnostics — do NOT duplicate that here.
    async extract(page, { progress, meta }) {
        // progress: ScrapeProgressTracker — call progress.discovered(n)
        //           after finding links, progress.unitDone() per item.
        // meta:     object — mutate to report pagesVisited, listingHits,
        //           detailPagesVisited, detailParseFailures, looksBlocked.
        return { items: [...], meta: { ... } };
    }
};
