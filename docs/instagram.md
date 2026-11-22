# Instagram club feed

Operator guide for the Instagram club pipeline: login, scraping, classification, field extraction, queueing and posting.

**Contents**
- [Overview](#overview)
- [Architecture](#architecture)
- [Environment](#environment)
- [Commands](#commands)
- [Data files](#data-files)
- [Re-auth flow](#re-auth-flow)
- [Backoff and alert](#backoff-and-alert)
- [Adding a club](#adding-a-club)
- [Test recipe](#test-recipe)
- [Troubleshooting](#troubleshooting)
- [Enabling the scheduler by default](#enabling-the-scheduler-by-default)
- [Open items](#open-items)

---

## Overview

A logged-in browser session reads recent posts from a list of club Instagram accounts. Each caption is classified, and rule-based extraction pulls out date, time, deadline, location, price, registration link, mode, organizer, audience and prize.

Fetched posts are posted to `CLUBS_CHANNEL_ID` as plain webhook messages (one bot-owned webhook per club) and queued in `/pending` as `ig_<shortcode>` items with source `instagram-<handle>`. A human reviews each pending item and posts it through the normal pipeline.

Pending items pass through the same marker and audit chokepoints as every other source. Fields that cannot be read are left empty and flagged, never invented. Recruitment and stale posts are tagged, never dropped.

## Architecture

```text
/insta-login -> session cookies (data/instagram/)
scheduler tick -> extractor (puppeteer) -> classifier -> fields -> enrichment -> bridge -> pending queue -> /pending -> posting
```

| Stage | File | Role |
|---|---|---|
| Login | `scripts/insta-login.js`, `src/core/instaLoginRunner.js`, `/insta-login` command | Establishes the Instagram session used by the extractor. Admin only (`ADMIN_USER_IDS`). |
| Extractor | `src/scrapers/extractors/social/instagram.js`, `src/scrapers/sources/social/`, `src/scrapers/lib/insta-detail-parse.js`, `insta-seen-store.js` | Opens each club profile in the logged-in browser, reads recent posts and captions. Registered in `src/scrapers/registry.js` behind `IG_SOCIAL_ENABLED`. Uses live selectors. |
| Classifier | `src/scrapers/lib/insta-classifier.js` | Decides whether a post is an event-style post worth queueing. Exports shared helpers (`findLinks`, month tables, day helpers) used by the fields module. |
| Fields | `src/scrapers/lib/insta-fields.js` | Pure rule-based extraction. No I/O. ASCII-only source. |
| Posting | `src/posting/socialPost.js` (facade) over `socialPaths`, `socialClubs`, `socialFormat`, `socialImage`, `socialPostsStore`, `socialBridge` | Posts plain webhook messages with a randomized title emoji, formats the caption for Discord, stores posts in `data/instagram/posts.json`. |
| Bridge | `src/posting/socialBridge.js` | `buildEventFromPost` turns a post plus its fields into a pending item (caption hints win, fields fill nulls). `queueItem` handles link dedup. |
| Scheduler | `src/posting/socialSchedule.js` | node-cron tick, one due club per minute. Gated by `IG_SCHEDULER`. Simulate with `scripts/insta-schedule-sim.js`. |
| Enrichment | `src/posting/socialEnrich.js` | Fetches og metadata for post links (SSRF-guarded, cached). Denylist covers forms and doc hosts (forms.gle, docs.google.com, linktr.ee) and URL shorteners. Gated by `IG_ENRICH`; `IG_ENRICH=0` is the kill switch. |

### Fields

```js
extractFields(caption, { nowMs, takenAt, handle })
// -> { date, endDate, time, deadline, location, price, registrationUrl,
//      mode, organizer, audience, prize, teamSize, college, phone, meta }
```

Unknown fields are `null`, never invented.

- **Reference day.** Dates without a year resolve against, in order: `takenAt`, the date in the caption wrapper, the age stamp ("3d", "2w"), then `nowMs`.
- **Dates.** English month dates, ISO, and dd/mm/yyyy. Nepali (BS) dates convert through a single adapter, `bsToAd`, backed by `nepali-date-converter` pinned at 3.4.2. A weekday in the caption narrows the year; a mismatch sets `meta.weekdayMismatch`.
- **Event date vs deadline.** A date after a cue such as "deadline", "last date", "closes", "register by" or "due" is a deadline. A `till`/`until` between two dates is a range separator, not a cue. An explicit deadline date wins over "rolling basis". "N days left" and "closes today" resolve against the post date.
- **Time.** 12-hour and 24-hour forms. A range with one meridiem ("1:45 - 4:30 PM") takes it for both ends unless that puts the start after the end. A zone after the time (NPT, UTC) is kept as a suffix. Deadline lines keep their own time.
- **Location and mode.** From `Venue`/`Location`/`Where` lines or the pin emoji. Platform-only values (Zoom, Meet, Discord) give `mode: 'online'`. `TBA` gives no location.
- **Price.** `0` is free, a number is Rs, a string is per-unit text. Prize lines are excluded from price.
- **Registration link.** Chosen from the post links plus scheme-less shortener hosts (shorturl.at, is.gd, ow.ly, buff.ly, short.io, tiny.cc, rebrand.ly, bitly.com). A link scores on a registration cue in its label (same line, or the previous two lines), a register/apply/signup path, or a known host. Form-host links (Google Forms, forms.gle, Office Forms, Typeform) need a register/apply/sign-up/rsvp/enrol/seat/spot cue. Survey wording (survey, feedback, interests, aspirations) disqualifies a form link. Deny list: syllabus, rulebook, guidelines, Discord, Drive, Docs documents, Notion, Canva, Facebook, YouTube.
- **Organizer.** "organized by", "hosted by", "co-organized by", or an `A x B` pairing of club-like names.
- **Audience.** "open to", "eligibility" and similar cues, or a levels line (School, +2, Bachelor-level students).
- **Prize.** Amounts near prize/reward/worth wording, or a gift giveaway at low rank.
- **Team size.** `teamSize`: "Team of 3", "2-4 members", "Up to 4 members", "Solo" or "Individual", from team-size wording. Different sizes in one caption keep the first and add a warning.
- **College.** `college`: a known college or campus name in an organizer, venue or open-to line (for example "IOE Pulchowk Campus").
- **Phone.** `phone`: the first Nepal number in the caption, normalized: mobile `98XXXXXXXX`, Kathmandu landline `01-XXXXXXX`. Prices and URLs are skipped.
- **Meta.** `dateFound`, `bsFailed`, `nonContiguous`, `weekdayMismatch`, `rolling`, `lastCall`, `stale`, `tags` (`recruitment`, `stale`), `warnings`, `type`, `timeShifts`, `prizeLowRank`.

### Chips

`pickChips(fields, type, nowMs)` returns up to three chips for the `/pending` renderer. Instagram items only; every other source renders as before. A date is not required. Candidates in rank order: last call or near deadline, register link, date (or time alone), location or online mode, prize (competition, hackathon, exhibition only), team size, level (school, +2, bachelor), price, college, organizer, phone, restrictive audience. Null fields are skipped and duplicate values are dropped, so fewer than three is normal. A college already shown in the location or organizer is not repeated.

No-repeat rule: a value shown as a chip is removed from the displayed description, and from any other embed field, at render time. A description line is removed only when its payload is the chip value (for example "Register Now: bit.ly/X", "Venue: Online", a phone line, "Team of 3"); a line that carries other content is kept. URLs compare by host and path, phones by digits. The stored caption and stored fields are never changed, and the register link appears exactly once on the item. Helpers live in `src/scrapers/lib/insta-chip-dedupe.js`.

Items queued before this change keep the chips stored at queue time.

### Bridge dedup

If a new post carries the same registration link as a pending Instagram item, only that item's deadline is updated and the post is reported as a duplicate. An item from a different source with the same link is not a duplicate.

### Bridge fields

`buildEventFromPost` stores `teamSize`, `college` and `phone` in `ev.fields` next to deadline, end date, prize, audience and tags. Hints still win; extracted fields only fill what is null. The register chip uses the hint link when there is one, otherwise the extracted link.

## Environment

| Variable | Meaning |
|---|---|
| `IG_SOCIAL_ENABLED` | Registry gate for the Instagram source type in `src/scrapers/registry.js`. |
| `IG_SCHEDULER` | Turns the scheduled fetch on or off. Off by default. |
| `IG_MIN_INTERVAL_HOURS` | Minimum hours between fetches of the same profile. |
| `IG_SINCE_HOURS` | Look-back window for new posts on each fetch. |
| `IG_MAX_PROFILES_PER_RUN` | Cap on profiles fetched in one scheduler run. |
| `IG_ENRICH` | Turns the enrichment step on or off. `0` is the kill switch. |
| `IG_ENRICH_CACHE` | Overrides the path of the enrichment cache file. |
| `IG_ONLY_CLUB` | Internal. Limits fetching to one club handle. Used by `/club` and the extractor for single-club runs and testing. |
| `CLUBS_CHANNEL_ID` | Discord channel for club posts. |
| `CLUBS_MAX_AGE_HOURS` | Maximum post age, in hours, for a post to be posted. |
| `CLUBS_FORCE_REPOST` | When true, posts already marked as posted may be posted again. |
| `ADMIN_USER_IDS` | Comma-separated Discord user IDs allowed to run `/insta-login`. |
| `PUPPETEER_EXECUTABLE_PATH` | Browser binary for the login script (Linux path; the bot runs in WSL). |

## Commands

All commands are guild-scoped to `HOME_GUILD_ID`.

| Command | Purpose |
|---|---|
| `/insta-login` (`status`, `verify`, `start`) | Check, verify or start the Instagram login. Restricted to `ADMIN_USER_IDS`. |
| `/club add <handle>` | Add a club account to the watch list. |
| `/club remove <handle>` | Remove a club account. |
| `/club list` | Show watched clubs. |
| `/club fetch <handle>` | Fetch a club's recent posts now and queue new items. |
| `/club refresh` | Refresh club data. See [Open items](#open-items). |

## Data files

All Instagram state lives under `data/instagram/`. The directory is created at runtime and is gitignored. Never commit it: it holds the logged-in session.

| Path | Role |
|---|---|
| `clubs.json` | Watched club accounts. |
| `cookies.json` | Logged-in session. Sensitive. |
| `dp/` | Browser profile data. Gitignored. |
| `seen/<handle>.json` | Per-club fetch state: seen post ids and `lastFetchedAt`. |
| `posts.json` | Posted club items and their pending-queue links (`ig_<shortcode>`). |
| `schedule.json` | Scheduler state: due times and backoff ladder. |
| `enrich-cache.json` | Enrichment cache. Path overridable with `IG_ENRICH_CACHE`. |
| `thumbs/` | Cached media thumbnails. |

Files named `*.bak.*` are local backups from migrations and can be deleted.

## Re-auth flow

1. The fetch fails on a login wall or an expired session and the failure counts toward the shared `login_required` backoff.
2. On the 5th consecutive block an alert is posted.
3. An admin runs `/insta-login start` (or `node scripts/insta-login.js --relogin`) and completes the login. `/insta-login status` shows whether the required cookies are present; `/insta-login verify` confirms the session is live.
4. Run `/club fetch <handle>` on one club to confirm posts come back, then let the scheduler continue.

## Backoff and alert

The scheduler picks one due club per minute. Consecutive blocks step the wait up a ladder of 5 minutes, 30 minutes, 2 hours. The 5th block posts an alert. A `login_required` backoff is shared across all clubs. A successful fetch resets the ladder. State is in `data/instagram/schedule.json`; source is `src/posting/socialSchedule.js`.

## Adding a club

1. `/club add <handle>`
2. `/club fetch <handle>`
3. Open `/pending` and check the new items: date, deadline, link, price, chips.
4. `/club list` to confirm the club is watched.

If fields look wrong for a caption, run it through the extractor directly:

```bash
node -e "const {extractFields}=require('./src/scrapers/lib/insta-fields');console.log(JSON.stringify(extractFields(require('fs').readFileSync(0,'utf8'),{takenAt:Date.now()}),null,2))" < caption.txt
```

## Test recipe

```bash
node --test tests/insta-classifier.test.js tests/social-post.test.js tests/social-bridge.test.js tests/social-schedule.test.js tests/social-enrich.test.js tests/insta-fields.test.js
```

`tests/fixtures/insta-fields.truth.json` holds 51 ground-truth caption rows (ASCII-only, phones scrubbed to `#PHONE`, handles to `@USER`). Rows are never loosened; the extractor is fixed instead. Rows without a weekday or AD anchor are marked `libraryDerived` and assert only the date format and a 366-day span.

Live check:

1. `/insta-login`
2. `/club add <handle>` then `/club fetch <handle>`
3. `/pending` on a fetched post: link, price, prize, audience and chips match the caption.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing queued after `/club fetch` | Session valid (`/insta-login`), post older than `CLUBS_MAX_AGE_HOURS` or `IG_SINCE_HOURS`, post already marked posted (`CLUBS_FORCE_REPOST`). |
| Fetch returns no posts | Instagram selectors changed. Refresh the extractor selectors. |
| Wrong or missing field | Reproduce with the extractor one-liner above, then add a truth row and fix `insta-fields.js`. |
| Registration link missing | The label needs a register/apply/sign-up/rsvp/enrol/seat/spot cue, or the URL path must contain one. Survey wording disqualifies form links. |
| Deadline read as event date | The cue before the date is not recognised. Add the cue pattern to the deadline cue list in `insta-fields.js`. |
| node-cron missed-tick warnings | Many clubs make one run outlast the tick. Lower `IG_MAX_PROFILES_PER_RUN` or raise `IG_MIN_INTERVAL_HOURS`. |
| Thumbnail broken on an old post | Instagram thumbnail URLs expire. Re-fetch the club to get a fresh URL. |
| `insta-login-command.test.js` hangs | Known hang at line 92. Run the six-file recipe instead. |

## Enabling the scheduler by default

`IG_SCHEDULER` ships off. After live verification (login, one successful `/club fetch`, items reviewed in `/pending`), change the default to on in `src/config/env.js`.

## Open items

- Per-variable default values for the `IG_*` and `CLUBS_*` variables.
- Exact behaviour of `/club refresh`.
- Live check of `/insta-login status`, `verify` and `start` replies is not yet reported.
- Cleanup of old test posts in the clubs channel and their `ig_<shortcode>` pending entries.

