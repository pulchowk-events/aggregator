# Pulchowk Events Aggregator User Guide

This guide covers the complete product from the point of view of someone
running, administering, or extending it: the Discord bot, its data and web
integrations, scraper maintenance, and the command-line tools.

Use the table of contents to jump to the task you need. Deep implementation
details live in the linked operator and developer references.

## Contents

- [What this repository does](#what-this-repository-does)
- [Choose your path](#choose-your-path)
- [Install and start the bot](#install-and-start-the-bot)
- [Use the bot in Discord](#use-the-bot-in-discord)
- [Connect Supabase and the public website](#connect-supabase-and-the-public-website)
- [Use the HTTP API](#use-the-http-api)
- [Command-line reference](#command-line-reference)
  - [Add and maintain scraper sources](#add-and-maintain-scraper-sources)
- [Run and maintain the service](#run-and-maintain-the-service)
- [Data, backups, and recovery](#data-backups-and-recovery)
- [Developer and test workflows](#developer-and-test-workflows)
- [Troubleshooting](#troubleshooting)
- [Related documentation](#related-documentation)

## What this repository does

The aggregator is a self-hosted Node.js service that:

1. Scrapes configured websites for events, jobs, and scholarships.
2. Normalizes, filters, and deduplicates results.
3. Places new items in a persistent review queue.
4. Lets administrators review items and post them to Discord test or live
   channels, manually or on an autopost schedule.
5. Archives posted items to one Supabase project and can sync a curated set
   to a separate public-website Supabase project.
6. Provides an HTTP API for operational status and integrations.

The repository includes three connected but distinct work areas:

| Area | Who uses it | What it does |
|---|---|---|
| Running bot | Server operators and moderators | Scrape, review, post, manage settings, and sync data. |
| Source maintenance | Scraper maintainers | Add or repair website extractors and deploy verified source files. |
| Development | Contributors and self-hosters | Configure, test, customize, and operate the service. |

The batch onboarding tools create scraper source files; they do not post items
to Discord. The running bot only uses scraper files that have been deployed
under `src/scrapers/` and loaded at startup.

## Choose your path

- **You only want to see events:** join the configured Discord server and read
  its event, job, or scholarship channels. The bot's slash commands are
  administrator-only.
- **You administer the bot:** start with [Install and start the bot](#install-and-start-the-bot),
  then [Use the bot in Discord](#use-the-bot-in-discord).
- **You operate the public website sync:** read
  [Connect Supabase and the public website](#connect-supabase-and-the-public-website)
  and [Use the HTTP API](#use-the-http-api).
- **You want to add a website:** use
  [Add and maintain scraper sources](#add-and-maintain-scraper-sources).
- **You are changing the code:** read
  [Developer and test workflows](#developer-and-test-workflows) and
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Install and start the bot

### Requirements

- Node.js 18 or newer and npm.
- A Discord application and bot token.
- A Discord server where the bot can read and post in the configured
  channels.
- Optional: Supabase projects for archival and/or public-website sync.
- Optional: a real browser profile for sites that need an authenticated or
  warm session. Puppeteer otherwise uses its installed Chromium.

Puppeteer may download Chromium during `npm install`. If you deploy on a
Windows host and need a logged-in browser profile, configure the Windows
browser paths in `.env`; a Windows path does not work when Node runs under
WSL2 or Linux.

### Prepare Discord

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the **Message Content** privileged intent for the bot.
3. Invite it to the target server with the `bot` and `applications.commands`
   scopes.
4. Give it access to the configured channels. It needs to view channels and
   send messages, embeds, and attachments; moderation operations such as
   duplicate deletion also need message-management permission.
5. Enable Developer Mode in Discord so you can copy the server, channel, and
   role IDs.

All commands are registered only in `HOME_GUILD_ID`. The person invoking any
bot command must have Discord's **Administrator** permission in that guild.
The bot rejects commands from other guilds, including DMs.

### Install the project

```bash
git clone https://github.com/pulchowk-events/aggregator.git
cd aggregator
npm install
npm link
```

`npm link` exposes this checkout's `pulchowk-events` command on your PATH.
Run it once from the cloned repository, then use `pulchowk-events <command>`
for repository tools. The bot itself remains separate: start it with
`npm start` and develop with `npm run dev`.

Create `.env` from the checked-in template:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`.

Fill in the Discord token, home guild, logs and audit channels, and the main
and test channels for every category you use. Never commit `.env` or paste a
token or service-role key into an issue or chat. The full key list and
defaults are in [`.env.example`](.env.example) and
[`docs/operations.md`](docs/operations.md#configuration-reference).

The setup wizard can guide you through the same configuration:

```bash
pulchowk-events setup
```

Preview the wizard without contacting Discord or Supabase and without writing
`.env`:

```bash
pulchowk-events setup --demo
```

The demo writes its sample output to the git-ignored
`data/demo-setup.env`. The real wizard previews changes and asks before
writing `.env`.

### Start safely

The example `.env` enables `DEV_MODE=true`. Keep it enabled while checking
startup and test-channel behavior. It blocks live posting and production
write actions; it does not prevent test-channel posting.

```bash
npm start
```

On Windows, `start-events-bot.bat` runs the same entry point. For development,
`npm run dev` restarts the process when files change.

At startup the bot logs in, registers guild slash commands, schedules the
scrape and maintenance jobs, reconciles its cache, and starts the HTTP API on
`WEB_PORT` (default `3001`). Use `/status` and `/health` in Discord to check
the runtime and channel permissions.

Before enabling live posting:

1. Confirm `/status` shows the expected server and scrape schedule.
2. Run `/health` and fix missing bot channel permissions.
3. Run a small scrape and review its items with `/pending`.
4. Test-post to a test channel and inspect the rendered message.
5. Set `DEV_MODE=false` (or remove it) and restart only when you are ready for
   live actions.

The default automatic scrape schedule is every six hours. The public website
sync has a separate hourly schedule when configured. You can change the
scrape schedule later with `/settings set-schedule`.

## Use the bot in Discord

### Understand the item flow

```text
website scrape -> filters and deduplication -> pending review queue
               -> test post or live post -> archival / website sync
```

Scraping does not immediately publish each newly found item. New items enter
the queue, where an administrator can inspect, edit, test, post, or skip
them. Autopost is a separate opt-in control.

### Scrape a source

Use `/scrape` and choose:

- `type`: `all`, `events`, `jobs`, or `scholarships`.
- `site`: leave empty to scrape all sources, or choose a source by its slug
  (for example `blacktech`).

Examples:

- `/scrape` - run all configured sources.
- `/scrape type:Jobs` - run job sources only.
- `/scrape type:Jobs site:blacktech` - run one source.

A scrape already in progress cannot be started a second time. Results and
source failures are written to the logs and audit log.

### Review pending items

Use `/pending` with an optional type filter (`all`, `events`, `jobs`, or
`scholarships`). Upcoming items are listed with action buttons:

| Button | Result |
|---|---|
| **Post to Test** | Choose a configured test category/channel. This is the recommended first check. |
| **Post to Live** | Choose a live category/channel. Live safety gates still apply. |
| **Customize** | Edit the title, description, date/time, location, and/or image before posting. |
| **Skip** | Remove the item from pending and add it to the skipped list. |

Use `/preview query:<title text>` to see one pending item without posting it.
If several items match, make the query more specific.

Live posting normally requires a valid image and no unresolved data-quality
warnings. An item without an image can still be test-posted; customize it with
a valid image URL before posting live. Items with location or quality warnings
should be checked against the source before going live. Past or near-deadline
items may be skipped by autopost even when manual review is still possible.

### Autopost

Autopost processes eligible pending items one at a time, independently for
events, jobs, and scholarships. The interval is per track; `0` means
back-to-back. The live track is restricted to the configured live posting
window (currently 6:00 AM–10:00 PM Nepal time).

| Command | What it does |
|---|---|
| `/autopost start-test type:<type> [interval_minutes:<n>]` | Start one or more test tracks. |
| `/autopost start-live type:<type> [interval_minutes:<n>]` | Start live tracks. Requires production mode. |
| `/autopost stop type:<type> target:<test\|live\|all>` | Stop selected tracks deliberately. |
| `/autopost set-interval type:<single type> target:<test\|live> interval_minutes:<n>` | Change one track's interval. |
| `/autopost status` | Show all six type/mode tracks and the live window. |

`type` accepts `events`, `jobs`, `scholarships`, `events_jobs`,
`events_scholarships`, `jobs_scholarships`, or `all` when starting/stopping.
`set-interval` accepts one type at a time. An interval of `0` is valid.

Autopost state is saved. After an unexpected restart, previously active
tracks may resume; a deliberate `/autopost stop` will not resume. `/shutdown`
stops tracks and exits the process, so a process supervisor may restart it.

### Bot settings and safety controls

| Command | Usage |
|---|---|
| `/settings set-logs channel:<channel>` | Choose the human-facing logs channel. |
| `/settings set-schedule cron:<expression>` | Change the scrape schedule; for example `0 */6 * * *` means every six hours. |
| `/settings set-lead-days days:<n>` | Minimum event lead time for autopost; `0` disables the minimum. |
| `/settings set-needs-attention-expiry-days days:<n>` | Days before unresolved needs-attention items are archived. |
| `/settings toggle-missed-scrape-catchup state:<on\|off>` | Control recovery after the bot misses a scheduled scrape. |
| `/category pause category:<category>` | Stop live posts for one category. |
| `/category resume category:<category>` | Resume live posts for one category. |
| `/category list` | List paused categories. |
| `/blacklist add type:<keyword\|organizer> value:<text>` | Automatically skip matching new items. |
| `/blacklist remove type:<keyword\|organizer> value:<text>` | Remove an exact blacklist entry. |
| `/blacklist list` | Show keyword and organizer rules. |

Available categories are `sports`, `software`, `hardware`, `gaming`, `music`,
`business`, `miscellaneous`, `jobs`, and `scholarships`.

Pings are separately controlled:

- `/ping on` and `/ping off` turn all live-post role pings on or off.
- `/ping add keyword:<text>` and `/ping remove keyword:<text>` manage the
  ping keyword allow-list.
- `/ping category category:<category> state:<on|off>` controls a category.
- `/ping list` displays global, keyword, and per-category settings.

Role pings are not required for posts. For a different Discord server,
review the role and emoji IDs in `src/config/roles.js` and
`src/config/emojis.js`.

### Find, restore, edit, and clean up items

| Command | Usage and effect |
|---|---|
| `/find query:<text>` | Search pending, posted, skipped, and needs-attention archived items by title. |
| `/restore query:<text>` | Move one matching skipped item back to pending. Use a more specific query if multiple items match. |
| `/clear-skipped` | Clear the entire skipped list. This is a bulk action. |
| `/undo [query:<text>]` | Delete a live post and restore its item to pending. Without a query, targets the most recent matching post. |
| `/edit-live query:<text>` | Find a live post and edit its stored fields and Discord message. |
| `/cleanup item_type:<type> [source:<slug>]` | Prepare a bulk cleanup of a type and optional exact source. Review the confirmation before it removes data. |
| `/dedupe [channel:<channel>] [limit:<n>]` | Scan recent live messages and delete duplicate bot posts. Defaults to all live channels and a small recent window. |
| `/publish-previous [channel:<channel>] [amount:<n>]` | Deduplicate and crosspost older eligible live messages. Without `amount`, scans up to the tool's hard limit; use carefully. |
| `/autopublish on|off|status` | Control automatic crossposting after new live posts pass duplicate checks. |

`/undo`, `/edit-live`, `/cleanup`, `/dedupe`, and `/publish-previous` can
modify Discord messages or persistent state. Check the target and use a test
channel or backup before bulk operations.

### Health and diagnostics

| Command | What it reports |
|---|---|
| `/status` | Queue counts, active scrape, autopost tracks, schedule, and missed-scrape state. |
| `/health` | Discord gateway and configured channel permissions. |
| `/stats [days:<n>]` | Posting activity over the requested lookback (defaults to seven days). |
| `/uptime` | Process uptime, Node version, memory, and process ID. |
| `/backup` | Download the current `data/cache.json`; this is not a full backup. |
| `/shutdown` | Emergency stop: halts autopost and exits the bot process. |

## Connect Supabase and the public website

The two Supabase integrations are independent. They use separate credentials
and serve different purposes.

### Bot archival Supabase

Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to archive posted
items. Tables can be renamed with `SUPABASE_EVENTS_TABLE`,
`SUPABASE_JOBS_TABLE`, and `SUPABASE_SCHOLARSHIPS_TABLE`.

Use:

- `/supabase status` to see configuration, last result, and autosync state.
- `/supabase sync-now` to upload posted items not yet synced.
- `/supabase republish-all` to re-upload the posted-item cache.
- `/supabase autosync-start [interval_minutes:<n>]` and
  `/supabase autosync-stop` to control automatic syncing.

`republish-all` is a force re-upload, not a backup or a test. Keep service-role
keys private.

### Public-website Supabase

Configure `WEBSITE_SUPABASE_URL` and
`WEBSITE_SUPABASE_SERVICE_ROLE_KEY`. Events, jobs, and scholarships have
separate tables and enable switches; see [`.env.example`](.env.example) for
the complete names and defaults. By default, the bot runs a website sync
hourly and after relevant scrape activity.

The website feed is curated, not a copy of the entire Discord queue. Items
may be excluded for missing/invalid images, quality warnings, blacklist
matches, expiry, or collisions with user-submitted items. Scholarships have
their own eligibility rules.

Use:

- `/website-sync status` to inspect configuration and the latest session
  result.
- `/website-sync health` to compare eligible items with website rows.
- `/website-sync now` or `/website-sync backfill` to run a sync.
- `/website-sync prune` to force-delete orphan rows from the events and jobs
  tables. This is destructive and bypasses the normal prune threshold;
  inspect health first. It does not prune scholarships.

`WEBSITE_SYNC_DRY_RUN=true` runs syncs in dry-run mode without database writes.
Set `DEV_MODE=false` as well: `DEV_MODE=true` blocks both scheduled syncs and
the manual `now`, `backfill`, and `prune` commands rather than running them in
dry-run mode.

If a website should not receive writes, set `WEBSITE_SYNC_ENABLED=false`.
Individual jobs or scholarship sync can also be disabled; see the env
reference.

## Use the HTTP API

The bot starts an Express API on `http://localhost:<WEB_PORT>` (default
`3001`). The repository currently ships an API and placeholder-image route,
not a complete visual dashboard application.

| Method and path | Purpose |
|---|---|
| `GET /api/events` | Read recently scraped items that have not yet been queued. |
| `GET /api/settings` | Read runtime settings, configured categories, and autopost state. |
| `GET /api/health` | Read scrape state, queue count, posting locks, and next scrape time. |
| `GET /api/consistency-check` | Run and report a cache/posted-marker consistency check. |
| `GET /api/needs-attention-expired` | Read archived needs-attention items. |
| `GET /api/scrape-progress` | Read the current scrape progress snapshot. |
| `GET /placeholders/<source>.png` | Serve a generated local placeholder image. |
| `POST /api/settings` | Update the logs channel; body: `{"logsChannelId":"..."}`. |
| `POST /api/send-event` | Post an existing item; body includes `eventId`, optional `testMode`, `category`, and `force`. |
| `POST /api/add-event` | Add a manually supplied item to recent events; body needs a non-empty `title`. |

Example read:

```bash
curl http://localhost:3001/api/health
```

Example test-channel post:

```bash
curl -X POST http://localhost:3001/api/send-event \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DASHBOARD_API_KEY" \
  -d '{"eventId":"ITEM_ID","testMode":true}'
```

For PowerShell, use `curl.exe` or `Invoke-RestMethod`.
`POST /api/send-event` can select live mode when `testMode` is false or
omitted. Live mode is subject to `DEV_MODE`, image, data-quality, duplicate,
and posting gates.

**Secure the API before exposing it.** Set `DASHBOARD_API_KEY` and
`DASHBOARD_ALLOWED_ORIGINS` in `.env`. Without an API key, mutating routes are
unauthenticated; without an origin list, CORS is open. CORS is not
authentication. Keep the port behind a firewall or trusted reverse proxy.

## Command-line reference

Install/link the package from the repository root as described above, then
run `pulchowk-events help` for the live command list. Repository scripts are
accessed through this command rather than by invoking `node scripts/...`
directly. The bot runtime is the exception and uses `npm start` or
`npm run dev`.

| Command | Purpose |
|---|---|
| `pulchowk-events setup` | Configure a deployment; supports `--demo` and `--resume`. |
| `pulchowk-events add <url> --type <type>` | Scaffold one scraper source. |
| `pulchowk-events fix [name\|all]` | Diagnose and repair source selector drift. |
| `pulchowk-events diagnose <name>` | Inspect one source's selectors and extraction. |
| `pulchowk-events verify <name>` | Run one source against its live website. |
| `pulchowk-events batch <command>` | Run a batch onboarding phase or workflow. |
| `pulchowk-events placeholders [options]` | Generate source placeholder images. |
| `pulchowk-events simulate [sources] [options]` | Exercise scraper/post formatting without changing bot state. |
| `pulchowk-events test-send [options]` | Build or send a one-off Discord webhook smoke test. |
| `pulchowk-events maintenance <task>` | Run checkpoint, migration, and cache-maintenance utilities. |
| `pulchowk-events test` | Run the repository's Node.js test suite. |
| `pulchowk-events help [command]` / `version` | Show help or the package version. |

### Add and maintain scraper sources

The bot currently includes event, job, and scholarship sources. The current
source catalogue and website-specific notes are in the
[README](README.md#sources-supported) and
[`docs/scrapers.md`](docs/scrapers.md#reference-current-sources).

### Verify or diagnose an existing source

These commands visit the live source site; they do not start a Discord scrape
or post anything.

```bash
pulchowk-events verify <source>
pulchowk-events diagnose <source>
pulchowk-events diagnose <source> --full
pulchowk-events fix <source>
```

`verify` runs the extractor and prints a sample and verdict. `diagnose`
inspects selector behavior; `--full` also runs extraction. `fix` can apply
unambiguous selector changes; inspect its proposed changes before using
`--apply`. Use `pulchowk-events fix` with no source to open the picker, or
`pulchowk-events fix all` to sweep sources.

### Add one source with the wizard

```bash
pulchowk-events add https://example.com/events --type events
```

Supported `--type` values are `events`, `jobs`, and `scholarships`. The source
name is derived from the URL; optionally pass `--name <slug>`. The wizard
captures page evidence, creates the wrapper and extractor stub, builds an
LLM-ready prompt, and guides the reply/verification flow.

Useful options:

- `--notes "<hints>"` adds site-specific instructions to the prompt.
- `--profile` uses the configured warm browser profile on Windows.
- `--no-interactive` writes the scaffolding and prompt without the guided
  LLM handoff.
- `pulchowk-events add --help` shows the accepted positional form too.

After implementation, run `pulchowk-events verify <name>`, review both files
under `src/scrapers/`, and commit them. The bot discovers new sources on its
next startup.

### Add or repair a source by hand

Each source is a wrapper plus an extractor:

- `src/scrapers/sources/<type>/<name>.js` registers the source.
- `src/scrapers/extractors/<type>/<name>.js` implements `extract(page, context)`.

The extractor returns `{ items, meta }`; the orchestrator owns browser
lifecycle, common sanitization, image enrichment, retries, and diagnostics.
Follow the contract and item-specific requirements in
[`docs/scrapers.md`](docs/scrapers.md#the-extractor-contract). Verify before
committing. Do not copy production data or secrets into source files.

### Onboard many job sources with batch

Prepare a text file with one URL per line, then start with a dedicated run ID:

```bash
pulchowk-events batch run urls.txt --run careers-november
```

The workflow is:

1. `init` snapshots source state and creates `data/batch/<run-id>/`.
2. `discover` fetches and classifies URLs.
3. `retry-rejected` attempts recovery for rejected URLs unless disabled.
4. `generate` renders supported ATS/templates or creates LLM prompts.
5. `check` validates prompt structure.
6. `paste` obtains extractor replies; `auto` verifies/refines until terminal
   states or limits are reached.
7. `deploy` stages verified passing extractors in `src/scrapers/`.
8. `report` summarizes results.

Batch onboarding currently targets job/career sources. It does not onboard
events or scholarships in bulk. Review the generated diff and commit
`src/scrapers/` yourself; deploy does not commit or restart the bot.

You can run these phases separately to inspect and resume work:

```bash
pulchowk-events batch init urls.txt --run careers-november
pulchowk-events batch discover --run careers-november
pulchowk-events batch generate --run careers-november
pulchowk-events batch check --run careers-november
pulchowk-events batch paste --run careers-november --provider chatgpt
pulchowk-events batch verify --run careers-november
pulchowk-events batch report --run careers-november
```

The batch run directory is resumable and retained; it stores raw HTML and
results. Keep it as the reference for later `refine` operations.

### Batch commands and options

Use `pulchowk-events batch help` for the safe top-level list. The individual
batch scripts do not all implement `--help`; use this guide and
[`docs/batch.md`](docs/batch.md) for phase-specific details rather than
assuming `batch <phase> --help` is harmless.

| Command | Main options | Purpose |
|---|---|---|
| `batch init <url-file>` | `--run <id>` | Create a run and seed its URL list. |
| `batch discover` | `--run`, `--urls <file>`, `--concurrency <n>`, `--limit <n>` | Fetch/classify URLs. |
| `batch retry-rejected` | `--run`, `--only a,b`, `--timeout <ms>`, `--max-candidates <n>`, `--concurrency <n>`, `--no-browser-fallback` | Try alternate career links and URL probes for rejected sites. |
| `batch generate` | `--run`, `--only a,b`, `--concurrency <n>`, `--timeout <sec>`, `--parallel <n>` | Generate deterministic templates or LLM prompts. |
| `batch check` | `--run` | Validate canonical prompt shape without scraping or sending prompts. |
| `batch paste` | `--run`, `--only`, `--provider`, `--manual`, `--extension`, `--timeout <sec>`, `--no-browser`, `--no-poll`, `--include-small`, `--resume-after-timeout` | Send prompts manually via clipboard or through the configured extension transport. |
| `batch follow` | `--run`, `--only`, `--max-hops <n>`, `--timeout <sec>` | Follow same-domain redirect verdicts and regenerate evidence. |
| `batch refine` | `--run`, `--only`, `--force`, `--max-attempts <n>` | Add verification failures to prompts for repair. |
| `batch promote` | `--run`, `--only`, `--force` | Convert eligible template failures to prompt-driven sources using saved dumps. |
| `batch verify` | `--run`, `--only`, `--timeout <ms>`, `--parallel <n>`, `--keep` | Stage and run generated extractors; `--keep` leaves staged files for inspection. |
| `batch auto` | `--run`, `--only`, `--provider`, `--manual`, `--extension`, `--resume-after-timeout`, `--parallel`, `--timeout <ms>`, `--max-rounds`, `--max-attempts` | Resume the verify/refine/paste loop. |
| `batch deploy` | `--run`, `--only`, `--type`, `--force`, `--force-low-quality` | Copy verified extractors to production source directories. Force flags bypass overwrite or quality protections; use deliberately. |
| `batch report` | `--run`, `--json`, `--verbose` / `-v` | Print or serialize run results. |
| `batch status` | `--run` | Summarize current run state without re-verifying. |
| `batch dry-run` | `--run`, `--mode main\|test`, `--source`, `--items`, `--json` | Evaluate items through posting gates without sending Discord messages. |
| `batch scrape-now` | `--sources a,b`, `--run`, `--type`, `--timeout <ms>` | Scrape already-deployed sources into a run for dry-run analysis. |
| `batch refine-filters` | `--type`, `--run`, `--from-audit`, `--from-reply`, `--provider`, `--no-browser`, `--timeout <ms>`, `--no-review`, `--accept-all` | Propose improvements to item filter rules from collected evidence. |
| `batch run <url-file>` | `--run`, `--only`, `--provider`, `--manual`, `--extension`, `--resume-after-timeout`, `--parallel`, `--timeout`, `--max-rounds`, `--max-attempts`, `--skip-deploy`, `--retry-rejected`, `--no-retry-rejected`, `--profile`, `--min-quality` | Run the resumable end-to-end onboarding workflow. |

For commands that accept `--only`, give comma-separated source slugs, for
example `--only aayulogic,blacktech`. `--run <id>` selects a run; without it,
commands generally use the latest run.

For `batch refine-filters`, the default is an interactive risk review.
`--no-review` prints the proposed diff without writing; `--accept-all` accepts
all proposed additions, but still runs safety tests and asks for a final write
confirmation. Proposed removals are included in that confirmed write. Review
rules carefully: a `drop` rule can silently discard a real item if its match
is too broad.

#### LLM provider and transport

- Manual mode copies a prompt to the clipboard and waits for a reply. The
  supported manual sites include DeepSeek, ChatGPT, and Claude.
- Extension mode sends prompts through the external `deepseek-connect` bridge.
  The provider name chooses the LLM; `EXTENSION_TOKEN` authenticates the
  transport and does **not** select ChatGPT.
- `--provider chatgpt` selects ChatGPT when supported by the selected
  transport. Extension provider availability comes from the bridge's
  provider registry.
- Without `EXTENSION_TOKEN`, paste defaults to manual mode. Use `--manual`
  or `--extension` to force a mode; `--extension` requires the token.

Newly generated extractor prompts are capped at 52,000 UTF-8 bytes and retain
required structure and captured evidence. Existing batch runs keep their old
prompt files; rerun `batch generate` or regenerate the selected source before
pasting an old prompt. Compact prompts are not skipped only because they are
under 40 KB; paste checks for captured evidence. `--include-small` forces
prompts with no captured evidence through.

Extension requests carry request IDs through to the bridge. The batch retries
only when the bridge confirms a failure happened before dispatch; an uncertain
or post-dispatch failure stops the batch and leaves a global request guard.
Inspect the provider tab and confirm the bridge queue is idle, then make sure
the original CLI process has exited before using `--resume-after-timeout`.
That flag clears local bookkeeping only—it does not cancel remote work or
prove that a reply was not already generated.

`batch run --dry-run` is currently parsed but is **not** a safety switch. Use
`--skip-deploy` to prevent deployment, keep `DEV_MODE=true` for bot safety,
or use the separate `batch scrape-now` + `batch dry-run` workflow to inspect
posting decisions without sending posts.

## Run and maintain the service

### Keep the process running

For a quick local session, use `npm start` in a terminal. Production hosts
should use a process supervisor so restarts and logs are managed:

| Host | Typical option |
|---|---|
| Linux | `systemd` service |
| Windows | Task Scheduler |
| Cross-platform | `pm2` |

Configuration examples, restart steps, and log handling are in
[`docs/operations.md#keeping-the-process-alive`](docs/operations.md#keeping-the-process-alive).
Do not run two bot instances against the same `data/` directory; they share
the cache and posting markers.

### Logs and health

- Console output gives startup, scrape, and post progress.
- `LOGS_CHANNEL_ID` receives human-facing progress and errors.
- `AUDIT_LOG_CHANNEL_ID` receives the audit mirror when configured.
- `data/audit-log.jsonl` remains the local record even if Discord logging
  fails.
- `data/batch/<run-id>/audit.jsonl` records batch work separately.

Check `/status`, `/health`, and recent log entries before investigating a
failure. `docs/operations.md` includes daily checks, log queries, alerts, and
symptom-based troubleshooting.

### Maintenance utilities

- `pulchowk-events placeholders [--only name1,name2] [--force]` generates
  missing images under `assets/placeholders/`. Existing files are skipped
  unless `--force` is supplied.
- `pulchowk-events test-send [--source <name>|--image <url>] [--mode diagnostic|live]`
  builds a one-off test payload. It defaults to `--dry`; add `--send` to
  actually post one message through the test webhook. A `--source` run still
  scrapes the site, even when dry.
- `pulchowk-events simulate [source1,source2]` runs selected scrapers through
  normalization and deduplication against the local cache. It defaults to
  `--dry`, which prints sample posts; add `--send` to send samples to
  `data/test-webhook.txt`. It does not write bot cache or markers.
- `pulchowk-events maintenance --help` lists all standalone maintenance
  utilities. They are grouped here so data-changing operations have an
  explicit command and warning:

  | Command | Purpose and safety |
  |---|---|
  | `pulchowk-events maintenance checkpoint save <name>` | Save a checkpoint of selected local cache and marker files; also supports `list`, `diff`, `import`, and guarded `restore`. |
  | `pulchowk-events maintenance migrate --from <legacy-repo> --dry-run` | Preview a legacy-data migration. Apply with `--confirm` only after stopping the bot. |
  | `pulchowk-events maintenance clean-erasmus --dry-run` | Preview removal of Erasmus Mundus scholarship cache entries and markers; apply with `--confirm` after stopping the bot. |
  | `pulchowk-events maintenance clean-scholarships --confirm` | Legacy destructive cleanup that removes all scholarship cache records and resets sync keys. It has no dry-run; back up `data/` and stop the bot first. |
  | `pulchowk-events maintenance cleanup-warnings --confirm` | Deduplicate warning arrays in pending cache entries. It writes `data/cache.json` directly; back up and stop the bot first. |

  `pulchowk-events maintenance checkpoint restore <id>` is a preview by
  default. Applying requires the full checkpoint ID with `--confirm <id>`; it
  also checks whether the bot is running unless `--force` is explicitly
  supplied. See
  [`docs/operations.md`](docs/operations.md) before migrating or altering
  production data.

## Data, backups, and recovery

The main state is local; Discord and Supabase are not substitutes for backing
up the repository's `data/` directory.

| Path | Purpose | Important? |
|---|---|---|
| `data/cache.json` | Pending, posted, skipped, archived items and runtime settings. | Back up. |
| `data/posted-channel-markers/` | Authoritative per-channel duplicate-prevention records. | Back up. |
| `data/audit-log.jsonl` | Append-only local audit history. | Back up for forensics. |
| `data/og-image-cache.json` | Derived image metadata. | Regenerable. |
| `assets/placeholders/` | Generated placeholder images committed with source files. | Regenerable. |
| `data/batch/<run-id>/` | URLs, dumps, prompts, generated files, results, and batch audit history. | Retain while a run may need repair. |

`/backup` downloads only `data/cache.json`. For full backup/restore steps,
including marker files, see [`docs/operations.md#backups`](docs/operations.md#backups).
Stop the bot before restoring or migrating data, then start it and check
`/status` and the audit log.

## Developer and test workflows

### Where to look

| Task | Main location |
|---|---|
| Runtime entry point | `src/index.js`, `src/bot.js` |
| Discord commands and interactions | `src/discord/` |
| Scraper registry and orchestrator | `src/scrapers/` |
| Posting, deduplication, and gates | `src/posting/` |
| Data and safety helpers | `src/core/` |
| Supabase archival | `src/integrations/supabase.js` |
| Public website sync | `src/integrations/websiteSync/` |
| HTTP API | `src/web/server.js` |
| CLI dispatcher | `scripts/cli.js` |
| Batch onboarding | `scripts/batch/` |
| Setup and source wizard | `scripts/setup/`, `scripts/wizard/` |
| Automated tests | `scripts/test/` |

### Run tests and checks

Run the Node.js test suite through the package CLI:

```bash
pulchowk-events test
```

`npm test` runs the same suite. To check one JavaScript file's syntax:

```bash
node --check path/to/file.js
```

For a scraper, `pulchowk-events verify <source>` is the live-site integration
check. For posting presentation, use the dry-run modes of the webhook and
scrape simulation tools before sending anything to a test webhook.

### Extend or fork the bot

- New scrapers should use the existing two-file source pattern and shared
  `runSource()` orchestrator.
- New Discord commands must remain guild-scoped and pass the centralized
  administrator gate.
- Preserve the shared posting, deduplication, marker, and audit paths; do not
  bypass them from handlers or extractors.
- Fork-specific emoji and some role IDs are in `src/config/`; deployment
  secrets and channel IDs are in `.env`.
- Review [`docs/architecture.md`](docs/architecture.md) and
  [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing core flows.

## Troubleshooting

| Symptom | First checks |
|---|---|
| Bot will not log in | Confirm `DISCORD_TOKEN`; check console output and `npm install`. |
| Slash commands are missing | Confirm `HOME_GUILD_ID`, that the bot is in that guild, and that the application has the `applications.commands` scope. Restart and inspect registration logs. |
| Commands say you need Administrator | The invoking Discord account needs Administrator in `HOME_GUILD_ID`; commands do not work in DMs or other guilds. |
| `/scrape` returns no items | Check `/status`, logs, the source's outcome, then `pulchowk-events verify <source>` or `diagnose <source>`. Empty pages and broken selectors are different outcomes. |
| Live post is blocked | Check `DEV_MODE`, category pause, image validity, data-quality warnings, duplicate status, and the live posting window. Try a test post first. |
| Public website is stale | Check `/website-sync status`, then `/website-sync health`; inspect sync credentials, dry-run settings, and audit logs. |
| Prompt is still very large | Check whether the batch run was generated before the 52 KB cap. Regenerate that source with `batch generate --run <id> --only <source>` before pasting. |
| Extension paste timed out | Do not advance to another source or blindly retry. Wait for the extension queue to drain; use `--resume-after-timeout` only after confirming the queue is idle. |
| Bot reposts after a restore | Stop the bot and inspect `data/cache.json` plus `data/posted-channel-markers/`; follow the consistency and backup guidance in the operations guide. |

For deeper symptom-specific steps, see
[`docs/operations.md#troubleshooting`](docs/operations.md#troubleshooting),
[`docs/scrapers.md#when-a-source-drifts`](docs/scrapers.md#when-a-source-drifts),
and [`docs/batch.md#failure-modes-and-what-to-do`](docs/batch.md#failure-modes-and-what-to-do).

## Related documentation

| Document | Use it for |
|---|---|
| [`README.md`](README.md) | Project overview, source catalogue, architecture summary, and quickstart. |
| [`docs/operations.md`](docs/operations.md) | Full configuration reference, supervisors, monitoring, backups, migration, and troubleshooting. |
| [`docs/scrapers.md`](docs/scrapers.md) | Extractor contract, source-specific behavior, verification, and repair. |
| [`docs/batch.md`](docs/batch.md) | Batch state machine, phases, provider details, flags, and failure handling. |
| [`docs/architecture.md`](docs/architecture.md) | Runtime data flow and module boundaries for contributors. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Testing, invariants, and pull-request expectations. |
