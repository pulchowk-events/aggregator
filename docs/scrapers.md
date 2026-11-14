# Scrapers

The scraper layer turns third-party websites into structured `{items, meta}` reports. This doc is the reference for adding a source, diagnosing a broken one with the CLI, and understanding why the abstraction exists.

**Contents**
- [Two layers: wrappers and extractors](#two-layers-wrappers-and-extractors)
- [The extractor contract](#the-extractor-contract)
- [The `{items, meta}` report](#the-items-meta-report)
- [Drift classification](#drift-classification)
- [Fallback chains](#fallback-chains)
- [Verifying a source](#verifying-a-source)
- [Diagnosing a source](#diagnosing-a-source)
- [Adding a source (guided)](#adding-a-source-guided)
- [Adding a source (batch)](#adding-a-source-batch)
- [Adding a source (manual)](#adding-a-source-manual)
- [When a source drifts](#when-a-source-drifts)
- [Reference: current sources](#reference-current-sources)

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

**The wrapper is boilerplate — you never edit it after creation.** It exists so the registry has a stable target to discover. `runSource` is the orchestrator, and it enforces every cross-cutting concern uniformly across every source: retry on failure, browser lifecycle, common sanitization, description trimming, image URL validation, image enrichment (see [Image enrichment — orchestrator-owned](#image-enrichment--orchestrator-owned)), and diagnostic classification.

**The extractor is source-specific — you edit it whenever the site changes.** It contains nothing but DOM logic: `page.goto()`, `page.evaluate()`, link harvesting, field extraction. It does not retry, does not sanitize, does not log to the audit trail, does not decide what to do with failure. The orchestrator handles all of that.

The practical consequence: when a source breaks, you open exactly one file. When you add a source, you write exactly one file (plus the 5-line wrapper). Everything else stays untouched.

**Two maintenance origins.** Every source in the repository was either hand-maintained (a human wrote the extractor, and fixes it by hand when the site drifts) or batch-maintained (produced by `pulchowk-events batch run`, and refined via `batch refine` on the original run directory). Both origins produce identical two-file sources, both go through the same `runSource()` orchestrator, and both fail the same way. The distinction matters for exactly one thing — which repair path to use when the source drifts (see [When a source drifts](#when-a-source-drifts)). See [Reference: current sources](#reference-current-sources) for the full per-source list.

---

## The extractor contract

The extractor module exports an object with up to two methods. Both are optional in shape but `extract` is required for the source to do anything.

### `extract(page, context)` — required

Called once per scrape run, with a live Puppeteer `Page` object and a context:

```js
async extract(page, { progress, meta }) {
    // page:     a Puppeteer Page, already set up with stealth config.
    //           null for browserless extractors (see below).
    // progress: a ScrapeProgressTracker instance (has .discovered(n), .unitDone(n))
    // meta:     an object you mutate to report what happened (see next section)
    return { items, meta };
}
```

**Must return `{ items, meta }` where `items` is an array of plain objects.** Each item should have at minimum an `id` and `title`. Everything else is optional; the orchestrator will fill in `source` and (if you haven't) `scrapedAt` from the source's declared name.

**Must not throw for recoverable failures.** Empty listing, individual detail-page load failure, one-off 403 — these should be logged to console, not thrown. The orchestrator retries the entire extractor on throw, which for a 200-page scrape means re-scraping 199 successful pages. Throw only when the failure is truly catastrophic (browser died, site is unreachable for 3+ retries).

**Must report progress.** Call `progress.discovered(n)` after finding N detail links on a listing page. Call `progress.unitDone()` inside the `finally` block of every detail-page visit. If you skip this, the progress bar stalls and ETA is wrong.

**Must update `meta` counters.** See the report section below.

**Log once, not per-item.** `console.log('[name] extracted X/Y jobs')` once at the end of `extract()`. Do not `console.log` inside per-item loops — a 40-item page would emit 40 log lines per scrape cycle, burying real output. One summary line per run is the standard.

### `browserless: true` — optional flag

The extractor can declare `browserless: true` to skip Puppeteer entirely. Used by the three ATS templates (`workable`, `personio`, `smartrecruiters`) that query a public JSON/XML API. When set:

- `page` is `null` in `extract()` — the extractor uses `fetch()` directly.
- The orchestrator skips retry (a rate-limited API call retried 3× wastes 45s; fail fast and let the next scrape cycle retry).
- The extractor is responsible for its own `AbortSignal.timeout()` on every fetch.

```js
module.exports = {
    browserless: true,
    async extract(page, { progress, meta }) {
        const res = await fetch('https://api.example.com/jobs', {
            signal: AbortSignal.timeout(15000)
        });
        // ... parse, push items, return { items, meta }
    }
};
```

### `preprocessItem(item)` — optional

Called once per item, after `extract()` returns, before the common sanitization pass. Signature is `(item) => item` — mutate and return.

Use it for source-specific cleanup that shouldn't live in the shared sanitizer. Example: NepVents embeds a wall of boilerplate (social links, register button, detail table) inside its description field. `preprocessItem` strips that via `cleanNepVentsDescription()` before the common sanitizer ever sees it.

Do not use it for the cross-cutting cleanups the common sanitizer already handles — image URL validation, description trimming, field-level mislabeling, image enrichment. Those are applied automatically to every source.

### Image enrichment — orchestrator-owned

Job postings rarely carry a per-item image. After `extract()` returns, `runSource` (in `src/scrapers/sources/_orchestrate.js`) derives one for every job item that came back without a valid image:

1. `deriveImageForUrl(url)` — fetches `<meta og:image>` from the site's homepage (falling back to `<link rel="icon">`). Caches the result per-hostname for 30 days in `data/og-image-cache.json`, and deduplicates concurrent in-flight fetches for the same hostname.
2. `derivePlaceholderForSource(name)` — returns a URL to a generated placeholder PNG in `data/placeholder-images/` if one exists, `null` otherwise. Placeholders are produced by `scripts/generate-placeholders.js` (Puppeteer one-shot: black background, white company name centered, auto-shrinking font for long names). Served from the bot's own Express route at `http://127.0.0.1:${WEB_PORT}/placeholders/<name>.png`.

Both functions live in `src/scrapers/ogImage.js` and are called from `sources/_orchestrate.js`, not from individual extractors. No job extractor handles image extraction itself — enrichment is uniform across every job source, hand-maintained or batch-maintained. Do not add `companyLogoUrl` extraction to any individual extractor.

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

The orchestrator adds three more fields the extractor does not touch: `durationMs` (wall-clock), `imagesEnriched` (count of job items that got an image derived post-extraction), and, for ATS templates, `atsEmpty` (true when the API responded successfully with zero postings — a pass, not a failure).

These feed `classifyOutcome`. Omitting them doesn't break the source, but it makes the difference between a diagnosable failure and an unexplained zero.

---

## Drift classification

After `extract()` returns, `classifyOutcome({items, meta})` decides what happened. The result drives `verify`'s verdict and the source-failure alert subsystem.

The statuses:

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

When `verify` or `batch verify` runs, that raw status is further subdivided into a reason code that the human-readable message catalogue (`src/core/messages.js`) maps to a full `{ label, explanation, fix }` entry. E.g. `dom_drift_listing` renders as *"Could not find the job listing — The page loaded fine, but the extractor's CSS selectors matched zero elements. The site probably restructured its HTML, or the extractor was written against a page shape that no longer exists. Next step: Run `pulchowk-events batch refine --only <site>`."*

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

`pulchowk-events verify <name>` (or `node scripts/verify-source.js <name>` without the CLI installed) runs a single extractor against the live site with no bot, no Discord, no cron. It's the unit test for a scraper. Output is identical between the two — the CLI is a thin subprocess wrapper around the script.

```bash
pulchowk-events verify khalti
pulchowk-events verify scholarshipsads
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

For sources that need a warm browser profile (Cloudflare, logged-in pages), the verify command must run on the machine that has that profile. On WSL2, `BROWSER_EXECUTABLE_PATH` pointing at a Windows path fails silently — verify from Windows instead.

**When you have 3+ sources to verify at once, use `pulchowk-events batch verify --run <id>`** instead of running `verify` N times. Same pass/fail semantics, parallel execution, one summary. See [`batch.md`](batch.md#verify-refine-promote).

---

## Diagnosing a source

`pulchowk-events diagnose <name>` (or `node scripts/diagnose.js <name>`) goes one level deeper than verify. Where verify tells you *whether* the source is broken (the verdict), diagnose tells you *which selectors broke* and what alternatives currently match.

```bash
pulchowk-events diagnose sathijob
pulchowk-events diagnose sathijob --full
```

The tool:

1. Loads the source's listing page in a fresh browser (no bot, no Discord).
2. Extracts every CSS-selector-shaped string from the extractor's source file.
3. Reports count + first-match sample for each selector.
4. For zero-match selectors, suggests common variations that DO match.
5. Optionally (`--full`) runs the actual extractor and correlates the verdict.

Modes:

| Flag | What it does |
|---|---|
| (none) | Fast — selectors only |
| `--full` | Also runs the extractor, correlates result |
| `--url <url>` | Override the target URL |
| `--json` | Machine-readable output |
| `--fix` | Print a suggested patch (does not write) |
| `--fix --apply` | Write the patch |
| `--all` | Sweep every source |

Read-only by default. Never mutates files without `--fix --apply` together. Exits 0 always — drift is a valid finding, not a failure.

Output shape:

```
▶ diagnose: sathijob (jobs)

=== page state ===
  loaded: ok
  looksBlocked: false

=== selectors (from extractor source) ===
  ✓ a[href*="/job/"]                                    14 matches
    sample: "Software Engineer @ ..."
  ✓ div[class*="job-card"]                              14 matches
    sample: "<div class=\"job-card ...\">"
  ✗ h1.job-title                                        0 matches  ← BROKEN
    alternatives:
      h1[class*="title"]                                14 matches
      .job-header h1                                    14 matches

=== extractor run ===
  items: 0
  verdict: dom_drift_detail
  detailParseFailures: 14/14
```

The `← BROKEN` marker plus the `alternatives` list is the whole value. When the title selector stops matching, diagnose tells you that in one command — no need to open devtools, no need to read the extractor source by hand.

`--json` output is the same data in a machine-readable shape, useful for the `fix` wizard (below) which parses it to decide whether a fix is unambiguous.

---

## Adding a source (guided)

The `add` command walks you through source creation end-to-end for a single source. It's a helper, not a replacement for understanding the extractor contract — read the sections above before running it.

```bash
pulchowk-events add https://example.com/events --type events
# or, without the CLI:
# node scripts/wizard/index.js https://example.com/events mynewsite events
```

The wizard:

1. **Loads the URL through Puppeteer.** Opens the page, waits for `domcontentloaded`, waits 3 seconds for late content.
2. **Dumps the listing structure.** JSON-LD types, anchor groups (grouped by href pattern), pagination signals (Next link / page param / Load More), category chips, card group fingerprints, plus the stricter `cardCandidates` / `detailLinkCandidates` fields.
3. **Auto-picks a detail link** (if any anchor group suggests one) and dumps the detail page structure too, including a scored `mainContentHeuristic` (title tag, description selector, first non-logo image).
4. **Classifies the site type:** `jsonld-first`, `listing-to-detail`, `single-page-cards`, or `unknown`.
5. **Writes three files:**
   - `src/scrapers/sources/<type>/<name>.js` — the wrapper (ready to commit)
   - `src/scrapers/extractors/<type>/<name>.js` — a stub with TODO comments
   - `src/scrapers/extractors/<type>/<name>.md` — a prompt file for an LLM (see below)
6. **Opens the interactive flow** — copies the prompt to your clipboard, offers to open DeepSeek, waits for you to paste the LLM's code back, writes it to the extractor, runs `verify` on it, and reports the verdict.

The prompt file contains: the site URL, the detected site type and evidence, the extractor contract, the item shape, one worked reference extractor (whichever of Khalti / KataJaam / NepVents matches the detected type), the full dump from steps 2-3, and a required `VERDICT:` line the LLM emits before the code (see [`batch.md`](batch.md#the-two-way-loop) for why).

If the LLM's output fails verification, the wizard offers to retry (paste new code) or regenerate the prompt with extra notes (`--notes "the cards are behind a Show More button"`).

The wizard is a starting point, not a guarantee. Sites with unusual structure (multi-stage navigation, required scroll, login gates) will need manual edits after the wizard runs. The whole value is: the boilerplate (imports, contract, meta counters, progress reporting) is right, and you spend your time on the parts only you can figure out.

**For three or more sources, use the batch pipeline instead.** `pulchowk-events batch run urls.txt --run mybatch` runs the same wizard flow across N URLs, verifies them in parallel, handles redirects and failures, and asks only for the paste round-trips. See [Adding a source (batch)](#adding-a-source-batch) below.

---

## Adding a source (batch)

When you have more than two or three sources to onboard, the batch pipeline is faster than the wizard-per-source loop. It handles URL resolution, template detection, prompt generation, verification, and failure retry — you handle only the LLM paste step.

```bash
pulchowk-events batch run urls.txt --run mybatch
```

`urls.txt` is one URL per line. The batch:

1. **Discovers.** Fetches every URL, follows career-page hints, detects ATS vendors, rejects dead links.
2. **Generates.** Renders a template where the DOM shape matches one of the four known templates; writes LLM prompts for the rest.
3. **Pastes.** Interactive clipboard loop through every prompt. Handles `NOT_CAREERS_PAGE` verdicts (skip) and `CAREERS_PAGE_REDIRECT` verdicts (follow inline) automatically.
4. **Verifies.** Runs every generated extractor against the live site in parallel.
5. **Refines.** LLM-origin failures get re-prompted with their own failure log. Bounded at 3 attempts.
6. **Deploys.** Verified-passing extractors are copied into `src/scrapers/` with wrappers, then you commit.

Full walkthrough: [`batch.md`](batch.md). The one-line answer for "should I use the wizard or the batch?" — wizard for one or two sources, batch for three or more.

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
        console.log(`  [mynewsite] extracted ${items.length}/${links.length} events`);
        return { items, meta };
    }
};
```

Note the single `console.log` at the end — one summary line per run. Do not log inside the per-item loop.

Commit both files, then verify:

```bash
pulchowk-events verify mynewsite
# or: node scripts/verify-source.js mynewsite
```

When it returns `verdict: ok` with a sensible item count, the source is live. The registry discovers it on the next scrape run.

---

## When a source drifts

Both maintenance origins end at the same place (a working extractor), but the mechanism differs. First step either way is the same: confirm the failure and figure out the origin.

**Confirm the failure.**

```bash
pulchowk-events diagnose <name>
```

This reports every selector the extractor uses, which ones broke, and which alternatives currently match. If you also want the formal verdict, `pulchowk-events verify <name>` runs the extractor end-to-end and prints the classifier's verdict.

**Find the origin.** The extractor file's first commit identifies which repair path applies:

```bash
git log --oneline --follow src/scrapers/extractors/jobs/<name>.js | head -3
```

A commit message matching `feat(scrapers): add N proven job sources from companies-76 batch` (or any other `batch run` commit) means the source is **batch-maintained**. A hand-commit (something like `feat(scrapers): ship all 10 extractors`, or a manual `fix:` commit on a single file) means **hand-maintained**. When in doubt, look at the extractor file's top-of-file comment: batch-generated extractors carry a banner like `// Extractor: <name> (jobs) -- single-page HTML card listing. // Generated by scripts/batch/templates/html-cards-listing.js.`, and the drift-repair hint points at `pulchowk-events diagnose` / `fix`. Hand-maintained extractors have a plain top comment documenting the site's structural quirks.

### Hand-maintained sources

**1. Try the auto-fixer.**

```bash
pulchowk-events fix <name>
# or: pulchowk-events fix          (interactive picker)
# or: pulchowk-events fix all      (sweep every source)
```

The fix entry point lists every source with last-known status, lets you pick one, runs the diagnosis, and offers to apply the fix if it's unambiguous — one broken selector, one unambiguous alternative. After applying, it re-verifies. If the diagnosis is ambiguous (multiple alternatives match equally), it falls through to manual.

Interactive by default. `--apply` skips the confirm prompt and applies non-interactively. `--full` also runs the extractor for correlation.

**2. Match the verdict to a manual fix (if auto-fix couldn't).**

- **`dom_drift_listing`** — listing selector matched nothing. Open the extractor, find the listing selectors (usually a `pickAll` call or a `page.evaluate(() => document.querySelectorAll(...))`), patch the primary selector to match current DOM, keep the old selector as a fallback.
- **`dom_drift_detail`** — detail pages yielded no titles. Same procedure, but for the detail title selector. Usually the title is an `<h1>` with a specific class that got renamed.
- **`blocked`** — the site served a captcha or Cloudflare challenge. Not a code fix. Set `BROWSER_EXECUTABLE_PATH` and `BROWSER_USER_DATA_DIR` to a profile that has manually solved the challenge once. On WSL2, this only works from Windows.
- **`empty`** — the site loaded, anchors were found, some detail pages yielded titles, but zero items came out. Either the site genuinely has no items right now, or a filter is rejecting everything. Check the console output — the extractor usually logs why items were skipped.

**3. Patch, verify, commit.**

After patching (auto or manual), re-run:

```bash
pulchowk-events verify <name>
```

Confirm `verdict: ok` and `items > 0`. Note the drift in the file's "Selector drift history" comment with the date and what changed. Commit.

**4. If the fix is a rewrite, note what changed.**

Structural drift (site moved from listing-to-detail to single-page-cards, or switched from HTML to JSON-LD) means a full extractor rewrite. Update the file's top comment to describe the new structure, and update the source table below in this doc to reflect the new reality.

### Batch-maintained sources

Do **not** hand-edit. The batch pipeline remembers the extractor's history (prompt, dump, verify attempts) and can regenerate with the failure evidence in front of the LLM.

**1. Refine via the batch loop.**

```bash
# Find the run that produced this extractor
git log --oneline --follow src/scrapers/extractors/jobs/<name>.js | head -3

# Refine using that run's saved state
pulchowk-events batch refine --run <run-id> --only <name>
pulchowk-events batch paste  --run <run-id> --only <name>
pulchowk-events batch verify --run <run-id> --only <name>
```

The refine step appends a `## Prior attempts` section to the prompt containing the failure log (item count, verdict, stderr tail). The LLM sees its own failure and usually produces a corrected extractor on the second try. Bounded at 3 attempts.

**2. If the site has genuinely changed shape** (moved domains, switched to ATS, became single-page), the correct response is a fresh extractor, not a refine. Either:

- Change the URL in `urls.txt`, re-init a new batch run, and let it generate a fresh prompt. Deploy the passing extractor.
- If the site now uses a recognized ATS (Workable, Personio, SmartRecruiters), the batch classifies it as such automatically — the template output replaces the old extractor entirely.

**3. Never patch batch-maintained extractors by hand.** A hand-patched extractor loses the tie to its batch run and cannot be refined in the future. If a hand-patch is the only option (rare — usually means the site is genuinely un-scrapable and the batch keeps failing), document why in the extractor's header comment so the next person knows it's off the batch loop.

### Both origins

**`blocked`** is not a drift problem. Set `BROWSER_EXECUTABLE_PATH` + `BROWSER_USER_DATA_DIR` to a warm profile and run on Windows. The batch pipeline and the single-source wizard both handle warm profiles — the batch just needs `--profile` to be passed through `batch run`'s environment.

---

## Reference: current sources

The current source set is whatever's committed under `src/scrapers/extractors/{events,jobs,scholarships}/`. For a live count:

```bash
ls src/scrapers/extractors/jobs/*.js | wc -l
ls src/scrapers/extractors/events/*.js | wc -l
ls src/scrapers/extractors/scholarships/*.js | wc -l
```

For a per-run view of sources still staged in a batch (not yet deployed), `pulchowk-events batch status`.

Every source listed below appears in `src/scrapers/sources/<type>/<name>.js` (the wrapper) and `src/scrapers/extractors/<type>/<name>.js` (the extractor). The registry discovers both at boot. The origin column is not part of the source's shape — it's a maintenance hint (see [When a source drifts](#when-a-source-drifts)), and it is inferred from the extractor file's first commit. To check the origin of a specific source:

```bash
git log --oneline --follow --reverse src/scrapers/extractors/jobs/<name>.js | head -1
```

The `Source` column identifies the site. `Notes` captures structural quirks, extraction strategy, or site-level limitations specific to that source.

### Events

| Source | Site | Notes |
|---|---|---|
| Khalti | `events.khalti.com` | Single-page DOM harvest, no per-event navigation. Fastest source. |
| KataJaam | `katajaam.com` | Nine category pages × per-event detail. Blur-up placeholder images need an `aria-hidden` filter. |
| NepVents | `nepvents.com` | Three category pages. JSON-LD-first extraction with HTML fallback. Registration URL is discovered by clicking through the site's own button. |
| Kgarira | `kgarira.com` | Three paginated listing pages × per-event detail. JSON-LD-first detail extraction. Pagination currently returns the same 3 items on each page — deduped downstream, just wasteful. |

### Scholarships

| Source | Site | Notes |
|---|---|---|
| ScholarshipsAds | `scholarshipsads.com` | Listing-only extraction. Listing cards carry everything including deadline (icon-calendar on some cards, no detail visit). Cloudflare-challenged past page 1 of each category; extractor deliberately stops after page 1. |
| Erasmus Mundus | `eacea.ec.europa.eu` | Two-hop scrape with year pre-filter. Deadlines are intentionally `unknown` (project duration ≠ application deadline). `fundingType` and `degreeLevel` are hardcoded EMJMD facts, not scraped. |

### Jobs

| Source | Site | Notes |
|---|---|---|
| SathiJob | `sathijob.com` | Virtualized listing, needs scroll-loop harvesting. Structured stat grid on detail pages. |
| InternSathi | `internsathi.com` | Same structural shape as SathiJob. Slug encodes level/employment-type/mode — used as fallback. |
| MeroJob | `merojob.com` | Normal server-rendered listing with real pagination. Deadlines are relative ("15 days from now") and are converted to absolute at scrape time. |
| KumariJob | `kumarijob.com` | Normal listing with real pagination. Detail pages can apply offsite (LinkedIn, employer ATS). |
| Aarambha IT | `aarambhait.com` | Single-page HTML card listing. |
| Aayulogic | `aayulogic.com/careers/` | Job listings on the site's careers section. |
| Adex International | `adex.ltd/` | Cloud/DevOps consulting firm's careers page. |
| Aegis Software | `aegishms.com/careers` | Hospitality software niche leader. |
| Agile Solutions | `agile.com.np/careers/` | Microsoft partner. |
| Alpas Technology | `alpastechnology.com/careers` | Boutique studio. |
| Bajra Technologies | `bajratechnologies.com/` | Leading Nepali tech firm. |
| Black Tech | `blacktech.com.np/career` | Pokhara-based software company. |
| Cedar Gate Technologies | `cedargate.com/careers-2/` | US healthcare tech. |
| Cloco Nepal | `cloco.com.np/careers/` | Japanese-backed company. |
| CloudFactory | `cloudfactory.com/careers` | Global data/AI company. |
| CloudTechService | `cloudtechservice.com/careers` | AWS/cloud consulting. |
| Daraz | `careers.daraz.com/` | E-commerce platform. |
| Dev | — | Careers URL not recorded in the source doc; check the extractor's `LISTING_URL` constant. |
| Devfinity | `devfinity.io/careers/` | Software company. |
| DishHome | `career.dishhome.com.np/` | DTH/ISP provider. |
| DLytica | `dlytica.com/career/` | Data/AI company. |
| Docsumo | `docsumo.com/careers/` | AI document startup. |
| E-Digital Nepal | `edigitalnepal.com/careers/` | Education-tech. |
| Ekbana | `careers.ekbana.com/` | Digital transformation. |
| Eminence Ways | `eminenceways.com/` | Cybersecurity. |
| ESignature | `esignature.com.np/` | Full-stack company. |
| Evolve | `evolveasia.co/` | FMCG tech startup. |
| F1Soft International | `career.f1soft.com/` | Leading fintech. |
| Fonepay | `fonepay.com/` | Payment network. |
| Genese Solution | `genesesolution.com/` | UK-based consulting. |
| GrowByData | `growbydata.com/` | Ecommerce data services. |
| Gurkhatech | `gurkhatech.com/careers/` | Digital marketing. |
| Hazesoft | `hazesoft.co/careers/` | Software firm. |
| HiTech Solutions & Services | `hitechnepal.com.np/career/` | ERP provider. |
| Hitachi (Pioneer Solutions) | `careers.hitachi.com/` (Nepal filter) | Hitachi Energy subsidiary. Uses the vendor's own careers search. |
| InfoDevelopers | `infodev.com.np/careers/` | IT services. |
| Intuji | `intuji.com/careers/` | Digital transformation. |
| Leapfrog Technology | `career.lftechnology.com/` | Leading software company. |
| Lunover Digital | `lunover.com/` | Web agency. |
| Manaram Technology | `manaram.group/` | Tech conglomerate. |
| MarginTop Solutions | `margintopsolutions.com/careers` | IT company. |
| Naxa | `naxa.com.np/` | Geo-ICT. |
| Nep Tech Pal | `neptechpal.com.np/careers/` | Pokhara digital provider. |
| Nimble Infosys | `career.nimble.com.np` | Established software company. |
| Progressive Labs | `progressivelabs.tech/careers/` | Software company. |
| Proshore | `proshore.eu/careers/` | Netherlands-Nepal company. |
| Quickfox Technologies | `quickfoxconsulting.com/careers/` | Technology consulting. |
| Skybase Innovations | `skybase.com.np/careers` | Pokhara digital agency. |
| SoftNEP | `softnep.com/careers` | Established software company. |
| Source Code | `sourcecode.com.np/join-us/` | Fintech company. |
| Sustainable Solutions (Sussol) | `sussol.net/jobs/` | Niche software company. |
| Tech101 | `tech101.com.np/` | Digital marketing. |
| Technorio | `technorio.com/career/` | IT company. |
| TeslaTech | `teslatech.com.np/` | Mobile game developer. |
| UXCam | `uxcam.com/careers/` | Mobile analytics platform. |
| Vianet Communications | `vianet.com.np/careers/` | ISP. |
| Vivasoft Nepal | `vivasoft.com.np/careers/` | Software outsourcing. |
| Viveka Health | `vivekahealth.com/careers/` | Health-tech. |
| Vrit Technologies | `vrittechnologies.com/careers/` | SaaS/EdTech. |
| Worldlink Communications | `worldlink.com.np/career/` | Largest ISP. |
| Yarsa Labs | `yarsalabs.com/` | Product company. |
| Ycotek (LIS Nepal) | `ycotek.com/careers` | IT services. |

Two sources have documented structural limits worth flagging up front:

- **ScholarshipsAds** scrapes only the first page of each category. Pages 2+ are behind Cloudflare's bot-detection wall, which a warm browser profile can't reliably bypass across many paginated requests. The extractor deliberately stops after page 1 — it captures the newest items per category, which is enough for a community feed. Deadline coverage is partial by structure, not by bug: only the subset of listing cards with an icon-calendar have a parsed deadline. The rest ship with an estimated-year-only deadline, which renders as a year rather than a specific date on the website.
- **Kgarira's** pagination returns the same 3 events on every page. The `MAX_PAGES = 3` loop therefore re-scrapes the same 3 events 3 times, producing 9 items before dedup (deduped to 3 by the downstream pipeline). Not a correctness issue, just throughput waste.

**Image enrichment is uniform across every job source.** Jobs typically have no per-item image. The orchestrator (`sources/_orchestrate.js`) derives a per-site image from `<meta og:image>` (cached in `data/og-image-cache.json`) or a generated placeholder PNG (`scripts/generate-placeholders.js`) when neither is present. This applies to every job source. Do not add `companyLogoUrl` extraction to any individual extractor — enrichment handles it uniformly.

**Prompt shape is locked.** `scripts/batch/lib/prompt-structure.js` validates every generated prompt against a canonical structure. If you change `scripts/wizard/prompt.js`, update the validator in the same commit — `pulchowk-events batch check` will fail otherwise. The lock exists so a prompt edit can't silently degrade every future extractor.