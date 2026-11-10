# Scrapers

The scraper layer turns third-party websites into structured `{items, meta}` reports. This doc is the reference for adding a source, diagnosing a broken one, and understanding why the abstraction exists.

**Contents**
- [Two layers: wrappers and extractors](#two-layers-wrappers-and-extractors)
- [The extractor contract](#the-extractor-contract)
- [The `{items, meta}` report](#the-items-meta-report)
- [Drift classification](#drift-classification)
- [Fallback chains](#fallback-chains)
- [Verifying a source](#verifying-a-source)
- [Adding a source (guided)](#adding-a-source-guided)
- [Adding a source (manual)](#adding-a-source-manual)
- [When a source drifts](#when-a-source-drifts)
- [Reference: the 10 current sources](#reference-the-10-current-sources)

---

## Two layers: wrappers and extractors

Every scraper source is two files.

```
src/scrapers/sources/<type>/<name>.js          ← 5-line wrapper
src/scrapers/extractors/<type>/<name>.js       ← the actual DOM work
```

The wrapper:

```js
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'khalti',
    type: 'events',
    scrape: (ctx) => runSource('khalti', 'events', ctx)
};
```

The extractor:

```js
module.exports = {
    // Optional: runs once per item, before common sanitization
    preprocessItem(item) { return item; },

    // Required: does all browser work, returns { items, meta }
    async extract(page, { progress, meta }) { /* ... */ }
};
```

Why this split exists:

**The wrapper is boilerplate — you never edit it after creation.** It exists so the registry has a stable target to discover. `runSource` is the orchestrator, and it enforces every cross-cutting concern uniformly across all 10+ sources: retry on failure, browser lifecycle, common sanitization, description trimming, image URL validation, diagnostic classification.

**The extractor is source-specific — you edit it whenever the site changes.** It contains nothing but DOM logic: `page.goto()`, `page.evaluate()`, link harvesting, field extraction. It does not retry, does not sanitize, does not log to the audit trail, does not decide what to do with failure. The orchestrator handles all of that.

The practical consequence: when a source breaks, you open exactly one file. When you add a source, you write exactly one file (plus the 5-line wrapper). Everything else stays untouched.

---

## The extractor contract

The extractor module exports an object with up to two methods. Both are optional in shape but `extract` is required for the source to do anything.

### `extract(page, context)` — required

Called once per scrape run, with a live Puppeteer `Page` object and a context:

```js
async extract(page, { progress, meta }) {
    // page:     a Puppeteer Page, already set up with stealth config
    // progress: a ScrapeProgressTracker instance (has .discovered(n), .unitDone(n))
    // meta:     an object you mutate to report what happened (see next section)
    return { items, meta };
}
```

**Must return `{ items, meta }` where `items` is an array of plain objects.** Each item should have at minimum an `id` and `title`. Everything else is optional; the orchestrator will fill in `source` and (if you haven't) `scrapedAt` from the source's declared name.

**Must not throw for recoverable failures.** Empty listing, individual detail-page load failure, one-off 403 — these should be logged to console, not thrown. The orchestrator retries the entire extractor on throw, which for a 200-page scrape means re-scraping 199 successful pages. Throw only when the failure is truly catastrophic (browser died, site is unreachable for 3+ retries).

**Must report progress.** Call `progress.discovered(n)` after finding N detail links on a listing page. Call `progress.unitDone()` inside the `finally` block of every detail-page visit. If you skip this, the progress bar stalls and ETA is wrong.

**Must update `meta` counters.** See the report section below.

### `preprocessItem(item)` — optional

Called once per item, after `extract()` returns, before the common sanitization pass. Signature is `(item) => item` — mutate and return.

Use it for source-specific cleanup that shouldn't live in the shared sanitizer. Example: NepVents embeds a wall of boilerplate (social links, register button, detail table) inside its description field. `preprocessItem` strips that via `cleanNepVentsDescription()` before the common sanitizer ever sees it.

Do not use it for the cross-cutting cleanups the common sanitizer already handles — image URL validation, description trimming, field-level mislabeling. Those are applied automatically to every source.

---

## The `{items, meta}` report

The `meta` object tells the orchestrator what happened during the run. It's what makes "0 items" diagnosable instead of mysterious.

```js
meta = {
    pagesVisited:        number,  // every page.goto() call
    listingHits:         number,  // total anchor matches across listings
    detailPagesVisited:  number,  // subset of pages that were detail pages
    detailParseFailures: number,  // detail pages that yielded no title
    looksBlocked:        boolean  // set true if any page looks captcha'd
}
```

Every field is initialized to `0`/`false` by `runSource` and mutated by the extractor as it works. You increment counters as you go:

```js
async extract(page, { meta }) {
    await page.goto(listingUrl, { timeout: 60000 });
    meta.pagesVisited++;                          // one page visit

    // Cheap block check on first load
    const state = await detectPageState(page);
    if (state.looksBlocked) meta.looksBlocked = true;

    const links = await harvestLinks(page);
    meta.listingHits = links.length;              // how many detail targets found

    for (const link of links) {
        await page.goto(link, { timeout: 30000 });
        meta.pagesVisited++;
        meta.detailPagesVisited++;
        const title = await extractTitle(page);
        if (!title) { meta.detailParseFailures++; continue; }
        // ... push item
    }
    return { items, meta };
}
```

Why each field matters:

- **`pagesVisited`** — total browser work done. Used to distinguish "listing selector returned nothing but page loaded fine" from "page never loaded."
- **`listingHits`** — how many candidate detail links were found. `0` means the listing selector is stale. `>0` with `detailParseFailures == detailPagesVisited` means the detail selector is stale.
- **`detailPagesVisited`** — confirms the loop actually ran. If `listingHits > 0` but `detailPagesVisited == 0`, the loop broke before iterating.
- **`detailParseFailures`** — how many detail pages produced no title. A high count means the title selector is broken; a low count with zero items means the loop is filtering items out for another reason.
- **`looksBlocked`** — set true when a captcha or Cloudflare challenge is detected. Overrides everything else: a blocked site that returns 0 items is a "blocked" failure, not a "drifted" failure.

These feed `classifyOutcome`. Omitting them doesn't break the source, but it makes the difference between a diagnosable failure and an unexplained zero.

---

## Drift classification

After `extract()` returns, `classifyOutcome({items, meta})` decides what happened. The result drives `verify-source.js`'s verdict and the source-failure alert subsystem.

The six statuses:

| Status | Meaning | Common cause |
|---|---|---|
| `ok` | `items.length > 0` | Everything worked |
| `blocked` | `meta.looksBlocked` true | Cloudflare, captcha, IP ban |
| `dom_drift_listing` | `listingHits == 0` and no items | Listing selector matched nothing |
| `dom_drift_detail` | `listingHits > 0`, `detailPagesVisited == detailParseFailures`, no items | Every detail page failed title extraction |
| `empty` | `listingHits > 0`, some detail pages yielded titles, but zero items survived the pipeline | Site genuinely empty, or filtering is too aggressive |
| `extractor_not_implemented` | No real extractor file — only a stub | Forgot to implement the extractor, or the source is a placeholder |
| `parse_failed` | Nothing else matched | Runtime error, or an extractor returning a malformed result |

The distinction between the four non-ok statuses is the whole point. `dom_drift_listing` means "fix the listing selector." `dom_drift_detail` means "fix the detail selector." `blocked` means "this is a network/bot-detection problem, not a code problem." `empty` means "the code is fine, the site has nothing right now." Each needs a different response, and the classifier is what tells you which.

---

## Fallback chains

Selector drift doesn't have to mean zero results. Two helpers — `pickOne` and `pickAll` — try a list of selectors in order, return the first that matches, and warn when a non-primary selector wins.

```js
const { pickOne, pickAll } = require('../../selectors');

// Single element
const titleResult = await pickOne(page, [
    'h1.text-display-xl.font-bold',      // current primary
    'h1[class*="text-display"]',         // last-known-good
    'h1'                                 // last resort
], { label: 'detail title' });
if (titleResult.fellBack) {
    console.warn(`Title selector fell back to "${titleResult.selector}" — update the primary`);
}
const title = titleResult.value;
```

`pickAll` is the same for lists:

```js
const listing = await pickAll(page, [
    'a.group.flex[href^="/events/"]',    // current primary
    'a.group.block[href^="/events/"]',   // pre-drift
    'a[class*="group"][href^="/events/"]'
], { label: 'listing card', attr: 'href' });
const links = listing.values;
```

When `pickOne` or `pickAll` returns with `fellBack: true`, that means the primary selector stopped matching and a fallback caught it. The warning is the drift signal — the source is working, but the primary needs updating.

The tradeoff: fallback chains make a source resilient to minor class name shuffles (badge color, wrapper class, etc.), but they don't help when the site changes structure entirely (listing cards become `<article>` instead of `<a>`, detail pages lose their JSON-LD, etc.). That's the "rewrite the extractor" case, not the "add a fallback" case.

Not every field needs a fallback chain. Use one for the fields most likely to drift (title, listing card wrapper, primary image) and let the rest use plain `querySelector`. A stale plain selector that fails produces `detailParseFailures++` and shows up in the verdict — same as a stale fallback chain, but without the noise.

---

## Verifying a source

`node scripts/verify-source.js <name>` runs a single extractor against the live site with no bot, no Discord, no cron. It's the unit test for a scraper.

```bash
node scripts/verify-source.js khalti
node scripts/verify-source.js scholarshipsads
```

Expected output:

```
▶ Verifying source: khalti (type: events)
  node: v22.19.0, platform: linux

=== result ===
items: 14
verdict: ok
listingHits: 14
detailPages: 14
parseFailures: 0
looksBlocked: false
duration: 18s

--- first 3 items ---
[0] Atif Aslam Live in Nepal
    date: Sat, 19 Dec
    itemType: event
    image: present
    warnings: 0
[1] Yabesh Thapa Ghaam Chhaya Tour 2026
    date: Sat, 21 Nov - Thu, 24 Dec
    itemType: event
    image: present
    warnings: 0
[2] Echoes of Bollywood ft. Monali Thakur
    date: Sat, 14 Nov
    itemType: event
    image: present
    warnings: 0
```

What to look at:

- **`verdict: ok`** — the only success state. Anything else needs investigating.
- **`items > 0`** — a source that returns zero items is broken, even if the verdict says "empty."
- **`warnings`** — if an item has data-quality warnings, they'll be listed in the `/pending` view when it goes live. Look for a pattern (e.g. "every image URL is a placeholder").
- **`duration`** — if a source took 5+ minutes, it's scraping too much. Consider capping pagination.

For sources that need a warm browser profile (Cloudflare, logged-in pages), `verify-source.js` must run on the machine that has that profile. On WSL2, `BROWSER_EXECUTABLE_PATH` pointing at a Windows path fails silently — verify from Windows instead.

---

## Adding a source (guided)

The `wizard/index.js` flow walks you through source creation end-to-end. It's a helper, not a replacement for understanding the extractor contract — read the sections above before running it.

```bash
node scripts/wizard/index.js <url> <name> <type>
```

Example:

```bash
node scripts/wizard/index.js https://example.com/events mynewsite events
```

The wizard:

1. **Loads the URL through Puppeteer.** Opens the page, waits for `networkidle2`, waits 2.5 seconds.
2. **Dumps the listing structure.** JSON-LD types, anchor groups (grouped by href pattern), pagination signals (Next link / page param / Load More), category chips, card group fingerprints.
3. **Auto-picks a detail link** (if any anchor group suggests one) and dumps the detail page structure too.
4. **Classifies the site type:** `jsonld-first`, `listing-to-detail`, `single-page-cards`, or `unknown`.
5. **Writes three files:**
   - `src/scrapers/sources/<type>/<name>.js` — the wrapper (ready to commit)
   - `src/scrapers/extractors/<type>/<name>.js` — a stub with TODO comments
   - `src/scrapers/extractors/<type>/<name>.md` — a prompt file for an LLM (see below)
6. **Opens the interactive flow** — copies the prompt to your clipboard, offers to open DeepSeek, waits for you to paste the LLM's code back, writes it to the extractor, runs `verify-source.js`, and reports the verdict.

The prompt file contains: the site URL, the detected site type and evidence, the extractor contract, the item shape, one worked reference extractor (whichever of Khalti / KataJaam / NepVents matches the detected type), and the full dump from steps 2-3. It's a self-contained prompt — paste it into DeepSeek (or any code-capable LLM) and the response should be a working extractor for that site.

If the LLM's output fails verification, the wizard offers to retry (paste new code) or regenerate the prompt with extra notes (`--notes "the cards are behind a Show More button"`).

The wizard is a starting point, not a guarantee. Sites with unusual structure (multi-stage navigation, required scroll, login gates) will need manual edits after the wizard runs. The whole value is: the boilerplate (imports, contract, meta counters, progress reporting) is right, and you spend your time on the parts only you can figure out.

---

## Adding a source (manual)

Skip the wizard if you know the site well. Two files:

**1. The wrapper** (`src/scrapers/sources/<type>/<name>.js`):

```js
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'mynewsite',
    type: 'events',
    scrape: (ctx) => runSource('mynewsite', 'events', ctx)
};
```

Name must match the filename stem. Type must match the directory (`events`, `jobs`, or `scholarships`). The registry warns if `name` doesn't match the file stem.

**2. The extractor** (`src/scrapers/extractors/<type>/<name>.js`):

Look at `src/scrapers/extractors/events/khalti.js` for the simplest working example (single-page cards, no detail pages). Look at `katajaam.js` for the listing-to-detail pattern. Look at `nepvents.js` for JSON-LD-first.

Minimum viable extractor:

```js
const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('🕷️ [mynewsite] Scraping listing...');
        meta.pagesVisited++;
        await page.goto('https://example.com/events', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2000);

        const state = await detectPageState(page);
        if (state.looksBlocked) { meta.looksBlocked = true; return { items: [], meta }; }

        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href^="/events/"]'))
                .map(a => a.href);
        });
        meta.listingHits = links.length;
        safeDiscovered(progress, links.length);

        const items = [];
        for (const link of links) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(1000);

                const raw = await page.evaluate(() => ({
                    title: document.querySelector('h1')?.textContent.trim() || null,
                    date: document.querySelector('time')?.getAttribute('datetime') || null,
                    location: document.querySelector('[class*="location"]')?.textContent.trim() || null,
                    image: document.querySelector('article img')?.src || null,
                    description: document.querySelector('[class*="description"]')?.textContent.trim() || null
                }));

                if (!raw.title) { meta.detailParseFailures++; continue; }

                items.push({
                    id: `mynewsite-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: raw.title,
                    description: raw.description || '',
                    date: raw.date,
                    location: raw.location,
                    image: raw.image,
                    url: link,
                    registrationUrl: link,
                    source: 'mynewsite'
                });
                await delay(800);
            } catch (error) {
                if (error.message.includes('403')) continue;
                console.error(`  ❌ ${link}:`, error.message);
            } finally {
                safeUnitDone(progress);
            }
        }
        return { items, meta };
    }
};
```

Commit both files, then verify:

```bash
node scripts/verify-source.js mynewsite
```

When it returns `verdict: ok` with a sensible item count, the source is live. The registry discovers it on the next scrape run.

---

## When a source drifts

The playbook, in order:

**1. Confirm the failure mode.**

```bash
node scripts/verify-source.js <name>
```

Read the `verdict` line, don't guess from the item count alone.

**2. Match the verdict to a fix.**

- **`dom_drift_listing`** — listing selector matched nothing. Open the extractor, find the listing selectors (usually a `pickAll` call or a `page.evaluate(() => document.querySelectorAll(...))`), inspect the current page in devtools, patch the primary selector to match current DOM, keep the old selector as a fallback.
- **`dom_drift_detail`** — detail pages yielded no titles. Same procedure, but for the detail title selector. Usually the title is an `<h1>` with a specific class that got renamed.
- **`blocked`** — the site served a captcha or Cloudflare challenge. Not a code fix. Set `BROWSER_EXECUTABLE_PATH` and `BROWSER_USER_DATA_DIR` to a profile that's manually solved the challenge once. On WSL2, this only works from Windows.
- **`empty`** — the site loaded, anchors were found, some detail pages yielded titles, but zero items came out. Either the site genuinely has no items right now, or a filter is rejecting everything. Check the console output — the extractor usually logs why items were skipped.

**3. Patch, verify, commit.**

After patching the extractor, re-run `node scripts/verify-source.js <name>`. Confirm `verdict: ok` and `items > 0`. Note the drift in the file's "Selector drift history" comment with the date and what changed. Commit.

**4. If the fix is a rewrite, note what changed.**

Structural drift (site moved from listing-to-detail to single-page-cards, or switched from HTML to JSON-LD) means a full extractor rewrite. Update the file's top comment to describe the new structure, and update the source table below in this doc to reflect the new reality.

---

## Reference: the 10 current sources

| Source | Type | Listing structure | Detail structure | Extraction strategy | Known limitations |
|---|---|---|---|---|---|
| **Khalti** | events | Single page, no pagination | None — all data on cards | Single `page.evaluate()` | Fastest source. Cards sometimes miss images. |
| **KataJaam** | events | 9 category pages | Per-event detail page | HTML extraction, blur-up image filter | 9 categories × ~10 events each per run. Detail pages occasionally 404. |
| **NepVents** | events | 3 category pages | Per-event detail page | JSON-LD-first, HTML fallback | Registration URL requires anchor-click discovery (some pages lack it). |
| **Kgarira** | events | 3 paginated pages | Per-event detail page | JSON-LD-first, HTML `h1` fallback | Pagination currently returns the same 3 items on each page — deduped downstream, just wasteful. |
| **SathiJob** | jobs | Virtualized scroll + Load More | Per-job detail page | Stat-grid label/value extraction | Scroll loop caps at 40 steps per load; jobs with unusual layouts may miss fields. |
| **InternSathi** | jobs | Virtualized scroll + Load more / Next | Per-job detail page | Stat-grid extraction, slug-based fallback | Same structure as SathiJob. Slug encodes level/employment-type/mode, used as fallback. |
| **MeroJob** | jobs | Real pagination (Next link) | Per-job detail page | Icon-based field extraction | Deadlines are relative ("15 days from now") — converted to absolute at scrape time. |
| **KumariJob** | jobs | Real pagination (rel=next / Next link) | Per-job detail page | Label/value row extraction, badge classification | "Apply Now" often points offsite — only used as `registrationUrl` when it's a well-formed http(s) URL. |
| **ScholarshipsAds** | scholarships | 2 category pages, paginated | Per-card detail visit for deadline lookup | Listing extraction + detail-page deadline scan | Page 1 only per category — page 2+ is Cloudflare-challenged. |
| **Erasmus Mundus** | scholarships | Single listing, paginated | Per-project detail page | Two-hop with year pre-filter | Deadlines intentionally `unknown` (project duration ≠ application deadline). No funding amount (total consortium grant ≠ per-student award). |

Two sources are documented as structurally limited:

- **ScholarshipsAds** scrapes only the first page of each category. Pages 2+ are behind Cloudflare's bot-detection wall, which a warm browser profile can't reliably bypass across many paginated requests. The extractor deliberately stops after page 1 rather than retrying — it captures the newest 20 items per category, which is enough for a community feed.
- **Kgarira's** pagination returns the same 3 events on every page. The `MAX_PAGES = 3` loop therefore re-scrapes the same 3 events 3 times, producing 9 items before dedup (deduped to 3 by the downstream pipeline). Not a correctness issue, just throughput waste — no easy fix until the site's pagination mechanism changes.