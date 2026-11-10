# Scraper extractors

Site-specific DOM extraction for each source plugin. One file per source,
implementing the `extract(page, { progress, meta })` contract from the
orchestration layer (`../sources/_orchestrate.js`).

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
        // meta:     object — mutate to report:
        //             pagesVisited, listingHits, detailPagesVisited,
        //             detailParseFailures, looksBlocked
        return { items: [...], meta };
    }
};
