# Contributing

For anyone modifying this codebase. Read this before opening a PR. The rules below exist because they've been broken before and the bugs they caused were expensive.

**Contents**
- [Before you touch anything](#before-you-touch-anything)
- [Code style](#code-style)
- [Testing philosophy](#testing-philosophy)
- [Adding a slash command](#adding-a-slash-command)
- [Adding a bot extension](#adding-a-bot-extension)
- [Adding a scraper source](#adding-a-scraper-source)
- [Commit conventions](#commit-conventions)
- [Pull request conventions](#pull-request-conventions)
- [Filing a useful bug report](#filing-a-useful-bug-report)

---

## Before you touch anything

Four functions are load-bearing safety guarantees. Bypassing any of them breaks the system silently — the bot keeps running, but duplicate posts start appearing, or audit trails develop holes, or markers stop being authoritative. The next person to debug will spend hours finding what happened.

**`postEventToCategory` — `src/posting/post.js`.** Every Discord post goes through this. If you call `channel.send()` directly from anywhere else for item content, you've bypassed the marker reservation, and the next scrape will post the same item again. If you need to send a message (a status reply, an error, a debug echo), that's fine — `channel.send({ content: 'something' })` from a handler is not an item post and doesn't need the marker system. The rule is specifically: **item posts always route through `post.js`.**

**`getEventDedupKey` — `src/posting/dedup.js`.** Every "has this been posted?" decision keys off this function. If you change how it computes identity — add a field, drop a field, change the canonical date anchor — the entire existing marker corpus and `postedEventKeys` set become meaningless. Existing markers won't match new keys. Every previously-posted item will re-post on the next scrape. Do not touch this without a migration plan that re-keys all existing markers.

**`auditLog` — `src/core/auditLogger.js`.** Every decision the bot makes writes through this. If you add a new decision point (a new filter, a new post gate, a new dedup signal), you must call `auditLog` with a machine-readable category and enough payload to reconstruct what happened. A decision that leaves no audit trail is a decision that's invisible when it misbehaves six months from now.

**`markers.reserve` — `src/core/markers.js`.** Every channel post reserves a marker file before sending. The `wx` write flag makes "check-and-reserve" atomic across processes. If you find yourself writing "check if marker exists, then send" instead of "reserve marker, then send," you've reopened the duplicate-prevention race. Two concurrent autopost ticks can both pass the check and both send. The atomic reservation is the entire guarantee.

If you're about to modify any of these, say so in the PR description and explain the migration path for existing data. If there is no migration path, the change is probably wrong.

---

## Code style

### Module boundaries

The layer rules in [`docs/architecture.md`](docs/architecture.md#module-boundaries) are not stylistic preferences — they're invariants. Enforced by review, not by tooling.

- **`src/config/`** — imports nothing from other `src/` layers. Reads `process.env` (in `env.js`) or hardcodes.
- **`src/core/`** — no `require('../bot')`. If a function needs bot state, it takes it as an argument.
- **`src/scrapers/`** — no `require('../posting/...')`, no `require('../bot')`. Returns `{items, meta}`; the pipeline takes it from there.
- **`src/posting/`** — the only layer that mutates `bot.cache`. Every state transition happens here.
- **`src/discord/`** and **`src/web/`** — thin adapters. No business logic, no cache mutations, no direct `postEventToCategory` bypass.
- **`src/integrations/`** — reads cache, writes to external services. Never mutates cache. All external calls wrapped in try/catch; failures logged, never thrown to callers.

If you're not sure which layer a new module belongs in, ask in the PR. Moving it later is cheap; wrong-layer mutations cause bugs that only show up under load.

### Naming

- One concept per file. Filenames describe the concept (`dedup.js`, `reconcile.js`, `deadlineText.js`), not the pattern (`Utils.js`, `Helpers.js`).
- Exported functions are the concept. `module.exports = { functionName, otherFunction }`. No default exports.
- Variables say what they are. `pendingEvents`, not `pe` or `arr1`. The one exception is inside `page.evaluate` bodies, where terseness helps because the whole block runs in the browser context and readability matters less than keeping DOM queries tight.
- Constants in `UPPER_SNAKE_CASE` if they're genuinely constant. `camelCase` if they're derivable once and reused. Magic numbers go in `src/config/constants.js`, never in line.

### No new dependencies without asking

Every dependency added is another thing that can break a fork. `package.json` has 11 direct dependencies; that's already a lot. Before adding a 12th, open an issue explaining:

1. What the dependency does
2. What the alternative is (usually: 15 lines of code)
3. Why the alternative isn't good enough

Most things that look like they need a dependency don't. `readline` handles prompt input. `crypto` handles hashing. `child_process` handles subprocess calls. The wizard's arrow-key menus and spinners are hand-rolled in `scripts/wizard/tui.js` — that's the bar.

### Async and error handling

- Every `await` on a network call is wrapped in try/catch. Every Discord API call, every Supabase call, every `page.goto`.
- Every try/catch logs what failed, why, and enough context to reconstruct it. `console.error(error)` alone is not enough — include the state that led to the error.
- Every "best-effort" call (Discord embed mirroring, audit trail, progress messages) is explicitly marked. `// best-effort` in a comment means: failure is logged, failure is not propagated.
- Don't swallow errors. `catch (e) { /* ignore */ }` is only acceptable when the failure genuinely cannot matter (a `client.destroy()` on an already-destroyed client), and even then there should be a comment explaining why.
- Fail closed on anything safety-related. Marker reconciliation failing to fetch Discord → treat as "still posted." Audit write failing → still attempt the Discord mirror. Never the other way.

### File size

`src/` files should stay under ~400 lines. Over that, split. `src/bot.js` was 6900 lines in a previous life; every time it got touched, some method's `this` binding broke in a way that took an hour to find. The current `bot.js` is ~600 lines of mostly delegation, and that's still too long — anything that can become a free function in `core/` or `posting/` should.

`src/scrapers/extractors/<type>/<name>.js` is exempt — those are allowed to be long because they're one file per site and the shape is dictated by the site.

### Comments

Comments explain *why*, not *what*. The code already says what.

Good:
```js
// KataJaam's blur-up pattern puts the blurred placeholder FIRST in the DOM
// and the real image second — a bare `querySelector('button.relative img')`
// always grabs the placeholder. Filter on aria-hidden !== "true" to get the
// real poster.
```

Bad:
```js
// Select the image
const imgEl = document.querySelector('img');
```

Every file's top comment should explain what the file does and why it exists as a separate file (if it's not obvious). Every function that has a non-trivial contract (return shape, error behavior, ordering) should document that contract in its docstring.

When in doubt about a magic number, a drift history, or a workaround — comment it with a date. `// 2026-11-10: KataJaam changed card class from group block to group flex` tells the next person exactly when the workaround became necessary and gives them a starting point if it breaks again.

---

## Testing philosophy

There is no automated test suite. This is deliberate, not an oversight.

The bot's behavior is dominated by interactions with external services (Discord API, Supabase, third-party websites) that can't be reliably mocked. A test suite that mocks those services would assert against the mocks, not against reality — it would pass while the bot silently breaks in production. The bot's actual correctness surface is: does the extractor return sensible data? Does the post go out once and only once? Does the audit log tell the story?

Each of those is verified manually, not by assertion.

### Per-source testing: `verify-source.js`

```bash
node scripts/verify-source.js <name>
```

This is the unit test for a scraper. It runs the extractor against the live site, prints item count, verdict, listing/detail counts, and a sample. If it returns `verdict: ok` with `items > 0`, the source works.

Run this after **every** extractor edit. Before every commit that touches `src/scrapers/extractors/`. Before every PR. It takes 30-90 seconds depending on the source.

### Behavior testing: boot + interact

For changes to `src/posting/`, `src/core/`, `src/discord/`, or `src/bot.js`:

1. Start the bot (`npm start`)
2. Watch the boot log for `✅ Ready handler completed all startup steps.`
3. Wait for one scrape cycle to complete (or trigger `/scrape` manually)
4. Check `/pending` and `/status` in Discord
5. Walk one item through review (Customize, Post to Test, then Post to Live)
6. Check the audit log for the full decision trail:

```bash
tail -50 data/audit-log.jsonl | jq -r '"\(.category)\t\(.message)"'
```

If the log tells a coherent story and no unexpected `error` level entries appear, the change works.

### Assertion surface: the audit log

The audit log is the closest thing to a test assertion this project has. Every decision the bot makes writes to it. If a change is correct, the log reflects the correct behavior. If a change is wrong, the log shows the wrong behavior.

When reviewing a PR that touches `posting/` or `scrapers/`, the review question is: *does the audit trail reflect the change?* If the change adds a new filter but doesn't audit it, the change is incomplete.

### Wizard testing: `--demo`

For `scripts/setup/index.js` changes, run `node scripts/setup/index.js --demo`. It walks the full flow with mock data and writes only to `data/demo-setup.env`. Reset with `rm data/demo-setup.env` between runs.

For `scripts/wizard/index.js` changes, run it against `https://example.com` (which detects `unknown`, exercising the fallback path) and against a known source URL (which detects `single-page-cards` or `listing-to-detail`, exercising the main path).

---

## Adding a slash command

Commands live in `src/discord/commands/`. Each is one file exporting `{ definition, handle }`.

**1. Create the file** `src/discord/commands/<name>.js`:

```js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const definition = new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('What it does')
    .addStringOption((opt) => opt
        .setName('arg')
        .setDescription('Argument description')
        .setRequired(true));

async function handle(bot, interaction) {
    // Validate input, call into posting/ or core/, respond to the user.
    // No cache mutations. No direct Discord sends of item content.
    await interaction.reply({ content: 'Done', flags: MessageFlags.Ephemeral });
}

module.exports = { definition, handle };
```

**2. Register the name** in `src/discord/commands/index.js`, in the `COMMAND_NAMES` array. That's the only place that needs updating. `definitions()` and `handleCommand()` are derived from it.

**3. Verify registration.** Restart the bot. Check the boot log for `✅ Slash commands registered to guild <id> only (N command(s))`. N should have incremented by 1.

**4. Test the command.** Run it in Discord. Check:
- Admin gate fires (run it in a non-admin account or foreign guild — should get ephemeral rejection)
- Command handles malformed input gracefully
- Any decision the command makes appears in `audit-log.jsonl`

**What handlers should NOT do:**

- Mutate `bot.cache` directly. Call a `posting/` helper instead — `bot.removeFromPending`, `bot.markEventPosted`, or a new function in `posting/` if the operation is new.
- Call `channel.send()` with item content. Route through `bot.postEventToCategory`.
- Contain loops. If your handler wants to iterate over items, that iteration belongs in a `posting/` or `core/` helper.
- Swallow errors. If a Discord API call fails, log the full error and reply with a user-visible message.

The handler's job is: parse interaction, validate permissions and inputs, call one function, format the response. If it's more than 50 lines, something belongs elsewhere.

---

## Adding a bot extension

Extensions live in `src/discord/extensions/`. Each is one file exporting `{ definitions, handlers }` where `definitions` is an array of `SlashCommandBuilder` and `handlers` is an object mapping command name → handler function.

**1. Create the file** `src/discord/extensions/<name>.js`:

```js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const definition = new SlashCommandBuilder()
    .setName('myextension')
    .setDescription('What it does');

async function handle(bot, interaction) {
    // Same rules as a slash command handler.
}

module.exports = { definitions: [definition], handlers: { myextension: handle } };
```

**2. Wire it into the aggregator** `src/discord/extensions/index.js`:

```js
const myExt = require('./my-extension');
const EXT_DEFINITIONS = [..., ...myExt.definitions];
const EXT_HANDLERS = { ..., ...myExt.handlers };
```

Nothing else needs to change. The extension's command registers via REST POST at startup, appears in the `/` menu.

**The interaction-wrapping gotcha.** Extensions may need to intercept interactions before the base handler sees them — for example, `/cleanup` has its own confirm-button flow, and the base `handleButton` would try to route those buttons to a nonexistent pending-event handler. The wrapping mechanism is in `attachInteractionRouter` in `extensions/index.js`: it captures the base listeners, installs its own that only handles extensions' own customId prefixes, and replays everything else through the originals.

If your extension adds a button or modal, prefix its customId with `ext_<extension-name>:` so the router can identify it:

```js
new ButtonBuilder().setCustomId(`ext_myext_confirm:${token}`)...
```

Then add the prefix to the `isExtButtonId` check and the corresponding handler to `EXT_MODAL_HANDLERS` or the button branch. Without the prefix, the base handler will try to parse it as one of its own (`post_live:`, `customize:`, etc.) and fail with a confusing "unknown action" error.

**Post-hooks.** Some extensions wrap `postEventToCategory` or `_processScrapedEventsLocked` to run logic after the base operation completes. Both wraps are in `attachPostHooks` and `attachBlacklistFilter` in `extensions/index.js`. If your extension needs to run after every post (e.g. crossposting, dedupe, metrics), wrap there. If it needs to inspect every scraped item before it goes to pending, wrap `_processScrapedEventsLocked`.

**The rule for post-hooks:** post-hooks run *after* the base operation succeeds, must never throw, and must never block the base result. If a post-hook fails, the base result is still returned. A failing post-hook that throws will cause the calling autopost tick to error, which causes the cache mutex to release, which causes the next tick to try again — but the item was already posted. Duplicates. So: try/catch around everything in a post-hook, log the failure, return the base result.

---

## Adding a scraper source

Two files: a 5-line wrapper and the extractor. Full walkthrough is in [`docs/scrapers.md`](docs/scrapers.md#adding-a-source-manual) — read that first, then come back here for the review expectations.

**Before opening a PR that adds a source:**

1. `node scripts/verify-source.js <name>` must return `verdict: ok` with `items > 0`
2. The item sample must have reasonable data: title populated, dates parseable, images real URLs (not placeholders)
3. If the source has category pages or pagination, the extractor must report `meta.listingHits` and `meta.detailPagesVisited` correctly
4. `meta.looksBlocked` must be set true if the source is captcha-gated, and the extractor must respect `--profile` correctly
5. The wrapper's `name` must match the filename stem

**Selector durability.** Reviewers will check: are the selectors likely to survive minor site changes? Prefer `pickOne`/`pickAll` with fallback chains for anything likely to drift (title, listing card, primary image). Use plain `querySelector` for stable fields. If a selector is a two-character class name or a deeply nested chain (`div > div > span:nth-child(3)`), flag it in a comment as fragile.

**Meta counters.** Every extractor must set at least `pagesVisited`, `listingHits`, `detailPagesVisited`. Without them, `classifyOutcome` can't distinguish `dom_drift_listing` from `dom_drift_detail` and the next drift incident takes 3× as long to diagnose.

**Drift history.** Every extractor file starts with a comment block documenting known drift events with dates. If you're adding a source, note the current site structure and the date it was verified. If you're fixing a drifted source, add a line documenting the change.

**Do not add a source that:**

- Requires a login the bot doesn't have
- Renders via JavaScript that Puppeteer can't execute (very rare — Puppeteer-extra stealth handles nearly everything)
- Relies on data the site explicitly forbids scraping (check `robots.txt` and terms)
- Has already been scraped by another source in this repo without a clear reason (a second source for the same site is a red flag — fix the first one instead)

---

## Commit conventions

One commit per concern. A bug fix and a refactor go in separate commits. A new source and a config change go in separate commits.

**Message format:** imperative mood, no prefix. Optionally use a `scope:` prefix when the scope isn't obvious from context.

```
feat: add kumarijob scraper source
fix: prevent duplicate post on stale marker reconciliation
refactor: extract cache loading into core/cache.js
docs: expand scraper drift playbook
chore: bump puppeteer to 22.15.0
```

Scope prefixes, used sparingly:

```
fix(scrapers): katajaam title selector fallback for text-display-xl
feat(posting): respect per-category pause in autopost tick
docs(operations): add systemd unit example
```

The prefix is for readability when `git log --oneline` is scanned. Don't force it — a clean imperative sentence is fine.

**What not to commit:**

- WIP commits. If you need to save state, use `git stash`.
- Commits that "fix tests" by changing tests. If a test is wrong, that's a separate commit explaining why.
- Commits that mix concerns. Three unrelated changes in one commit makes `git bisect` useless and `git revert` dangerous.
- Commits that touch `.env` (it's gitignored — if you see it in `git status`, that's a setup problem, not a commit problem).
- Commits that add files under `data/` (gitignored — see above).
- Commits that add `wizardtest.js` or `khalti-test.js` or any other scratch file. `git status` before every commit; if you see test files, delete them.

**Commit message body**, when needed, explains *why* the change was made, not *what* it does. What it does is in the diff.

```
fix: prevent duplicate post on stale marker reconciliation

The reconcile path treated "verify returns not-found" as "marker released."
On Discord rate limit (429), verify returned not-found with an error, and
the marker was cleared — the next tick posted again. Now verify returns
{verified: false, found: false} on error, and hasBeenPostedToChannel
treats unverified as still blocking. Fail-closed.

Affected path: posting/reconcile.js::hasBeenPostedToChannel.
```

---

## Pull request conventions

**Scope.** A PR touches one concern. If you find a second thing that needs fixing while working on the first, open a second PR. Reviewers can review a fix for one bug in 5 minutes; reviewing a fix-for-one-bug-plus-a-refactor-plus-a-new-feature takes 30.

**Description.** Explain the change in this order: what problem it solves, what the fix is, what it deliberately does *not* fix. The last point matters — a reviewer who knows the boundaries of a change reviews faster.

**Testing evidence.** Every PR description includes the commands you ran and their output. Not "tested locally" — the actual command:

```
$ node scripts/verify-source.js khalti
▶ Verifying source: khalti (type: events)
=== result ===
items: 14
verdict: ok
```

Or, for a `posting/` change:

```
$ tail -20 data/audit-log.jsonl | jq -r '"\(.category)\t\(.message)"'
post_event_outcome    Post outcome for "Test Event": success
dedup_decision        "Test Event" classified as new
```

A PR that says "tested" without the command and output is asking the reviewer to trust you. Don't ask for trust; show the evidence.

**What reviewers check:**

1. Does the change respect the four chokepoints above?
2. Is the layer boundary correct? (Cache mutation in `posting/`, not `discord/`; no `require('../bot')` from `core/`; etc.)
3. Does the change add an audit trail?
4. Does the change test itself? (verify-source for scrapers, boot + interact for posting, `--demo` for wizard)
5. Is the commit history clean? (One concern per commit, imperative messages)

Reviewers will request changes if any of those are missing. That's not pedantry — it's the only enforcement mechanism for the invariants documented in `architecture.md`.

**What reviewers do NOT check:** whether the change is *good* in some abstract sense. The bar is: does it work, does it respect the invariants, is it tested. Style preference and code golf are not review criteria.

---

## Filing a useful bug report

A bug report that says "it doesn't work" is not a bug report. It's a request for the maintainer to do the debugging you were already doing.

A useful bug report includes:

**1. What you expected vs. what happened.** One sentence each.

```
Expected: /scrape should find new events from khalti
Actual: log said "Found 0 new items" and pending queue stayed empty
```

**2. The relevant audit-log slice.** Always.

```bash
tail -100 data/audit-log.jsonl | jq 'select(.timestamp > "2026-11-11T18:00:00")' > /tmp/slice.json
```

Attach `slice.json`. The audit log contains the full decision trail; if you trimmed it, trim it by timestamp, not by category. A bug report without the audit log is a bug report without the debugging surface.

**3. The `verify-source` verdict**, if the bug is scraper-related.

```bash
node scripts/verify-source.js khalti
```

Paste the full output. The verdict is the diagnosis; without it the maintainer will run the same command first thing, adding a full round-trip.

**4. The environment shape.** Not the full `.env` — the relevant keys:

```
node: v22.19.0
platform: linux (WSL2)
OS: Ubuntu 24.04
puppeteer: 22.15.0
BROWSER_EXECUTABLE_PATH: (unset)
BROWSER_USER_DATA_DIR: (unset)
```

If the bug is "Cloudflare blocks me" and `BROWSER_EXECUTABLE_PATH` is unset, the maintainer knows immediately that the fix is "set the profile." Without the env shape, they'll ask and wait for a reply.

**5. What you already tried.** Even "I tried restarting the bot" saves the maintainer one step. Even "I looked at `audit-log.jsonl` and didn't understand the `autopost_filter_skip` entries" tells them where the confusion is.

**What not to include:**

- Screenshots of the console. Paste the text; screenshots can't be grepped.
- Full tracebacks without the error line highlighted. Highlight the actual error message.
- "The bot is broken." It isn't; some part of it is. Narrow it down.

If you're not sure whether something is a bug or expected behavior, check [`docs/operations.md`](docs/operations.md#troubleshooting) first. The troubleshooting matrix covers the 15 most common "is this a bug" cases. If your scenario isn't there, file it — that tells the maintainer the docs are missing a case.

---

## One last thing

If you're about to make a change and any of the above feels wrong or overly strict — say so. The rules here are what the codebase has learned from its own bugs. If a rule turns out to be wrong for a case it wasn't written for, that's a reason to change the rule, not to violate it silently. Open an issue, describe the case, propose the exception. Everything in this document is negotiable; nothing in this document is ignorable.