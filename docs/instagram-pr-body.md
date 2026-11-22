# Instagram club feed

Adds a pipeline that reads club Instagram accounts, extracts event fields from captions, and queues items for review in `/pending`. Operator guide: `docs/instagram.md`.

## What shipped

- **Login.** `scripts/insta-login.js` and `/insta-login status|verify|start`, admin-only through `ADMIN_USER_IDS`. Re-auth flow documented.
- **Extractor.** Puppeteer reader for club profiles and post captions.
- **Classifier.** `src/scrapers/lib/insta-classifier.js` decides which posts are queued. Exports shared helpers.
- **Fields (S9).** `src/scrapers/lib/insta-fields.js`: rule-based extraction of date, end date, time, deadline, location, price, registration link, mode, organizer, audience and prize. BS dates convert through one adapter. Backed by a 51-row ground-truth fixture.
- **Posting.** Plain webhook messages (one bot-owned webhook per club) to `CLUBS_CHANNEL_ID`, caption wrapper stripped, randomized title emoji, in `src/posting/socialPost.js` and its split modules. Posted items auto-queue into `/pending` as `ig_<shortcode>`.
- **Bridge.** `buildEventFromPost` builds pending items; link dedup updates only the deadline of a matching pending Instagram item.
- **Pending renderer (chips v2).** Up to three ranked chips per Instagram item: last call or deadline, register link, date, location, prize, team size, level, price, college, organizer, phone. Chip values are stripped from the displayed description at render time and the register link shows once. New fields: `teamSize`, `college`, `phone`. Other sources render as before.
- **Scheduler.** node-cron loop, one due club per minute, per-profile minimum interval, look-back window, per-run profile cap, backoff ladder (5 min, 30 min, 2 h), alert on the 5th block, shared `login_required` backoff. `IG_SCHEDULER` ships off.
- **Enrichment.** Optional, SSRF-guarded og metadata fetch with cache and host denylist, behind `IG_ENRICH` (`IG_ENRICH=0` kills it).
- **Commands.** `/insta-login status|verify|start`, `/club add|remove|list|fetch|refresh`.
- **Docs (S8C).** `docs/instagram.md`.

## Configuration

New env vars: `IG_SOCIAL_ENABLED`, `IG_SCHEDULER`, `IG_MIN_INTERVAL_HOURS`, `IG_SINCE_HOURS`, `IG_MAX_PROFILES_PER_RUN`, `IG_ENRICH`, `IG_ENRICH_CACHE`, `CLUBS_CHANNEL_ID`, `CLUBS_MAX_AGE_HOURS`, `CLUBS_FORCE_REPOST`. `IG_ONLY_CLUB` is internal. See `docs/instagram.md`.

## New dependency

`nepali-date-converter@3.4.2`, MIT, pinned.

## Tests

Six files: insta-classifier, social-post, social-bridge, social-schedule, social-enrich, insta-fields.

| Tests | Pass | Fail | Skipped |
|---|---|---|---|
| 183 | 183 | 0 | 0 |

## Untested

- Live-only selectors. They may need a refresh every few months.
- No Instagram fixtures. Extractor behaviour against real pages is verified only live.
- Buttons on webhook messages.
- Cookie lifetime. Session expiry timing is unmeasured.
- `/insta-login status`, `verify` and `start` live replies are not yet reported.
- S9 live check of `/pending` chips on a fetched sample is not yet reported.

## Known issues

- `insta-login-command.test.js` hangs at line 92.
- node-cron missed-tick warnings with many clubs.
- Thumbnail URLs expire.
- `igrev:` leftover remains.
- Two atomic-write copies are not migrated to the shared helper.
