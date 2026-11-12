# Operations

Day-2 operations: keeping the bot running, tuning it, diagnosing it, backing it up, and recovering from the things that will eventually go wrong. For the conceptual model — what the bot actually does — read [`architecture.md`](architecture.md) first.

**Contents**
- [Keeping the process alive](#keeping-the-process-alive)
- [Configuration reference](#configuration-reference)
- [Tuning constants](#tuning-constants)
- [Monitoring](#monitoring)
- [Backups](#backups)
- [Migration from a legacy deployment](#migration-from-a-legacy-deployment)
- [Setup wizard](#setup-wizard)
- [Troubleshooting](#troubleshooting)
- [Alerts](#alerts)
- [Log rotation](#log-rotation)

---

## Keeping the process alive

`node src/index.js` is the entry point. Nothing in the code restarts the process on its own — the `process.on('SIGINT'/'SIGTERM')` handlers do a clean shutdown, but re-launching after a crash or reboot requires an external supervisor. This is deliberate: a supervisor gives you real restart behavior for crashes, OOM, and hangs. A self-restart command doesn't.

Three supported patterns, in order of preference.

### systemd (Linux)

The cleanest option. Handles reboot, crash restart, log rotation, and env isolation.

`/etc/systemd/system/pulchowk-events-bot.service`:

```ini
[Unit]
Description=Pulchowk Events Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/repo
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/pulchowk-events/bot.log
StandardError=append:/var/log/pulchowk-events/bot-error.log
Environment="NODE_ENV=production"

# Hardening (optional but recommended)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/path/to/repo/data /var/log/pulchowk-events

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pulchowk-events-bot
sudo systemctl status pulchowk-events-bot
journalctl -u pulchowk-events-bot -f
```

`Restart=on-failure` restarts on crash but not on clean shutdown — so `/shutdown` (which exits 0) leaves the bot down until you manually start it again. That's the correct behavior; `/shutdown` is meant for operator intervention.

### Task Scheduler (Windows)

Used when the bot runs on a Windows host and benefits from a warm Brave/Chrome profile for Cloudflare-gated sites.

Create a task:

- **Trigger:** At startup, delay 2 minutes (allows network to come up before the bot tries to log in)
- **Action:** Start a program — `cmd.exe` — arguments: `/c "cd /d D:\path\to\repo && node src\index.js"`
- **Settings:** "Run whether user is logged on or not" (checked), "Restart the task if it fails" (checked, every 5 minutes, up to 3 attempts)
- **Start in:** `D:\path\to\repo`

The `start-events-bot.bat` script at repo root does the `cd` for you:

```bat
@echo off
cd /d "%~dp0"
node src\index.js
```

Point the task's action at that batch file if you prefer. Right-click → Run starts it immediately.

To kill it cleanly before an update: Task Scheduler → find the task → End. Or in PowerShell: `Get-Process node | Where-Object { $_.Path -like '*pulchowk-events*' } | Stop-Process`.

### pm2 (cross-platform alternative)

Simpler than systemd but adds a dependency. Good for dev boxes or when you're not on Linux.

```bash
npm install -g pm2
pm2 start src/index.js --name pulchowk-events-bot
pm2 save
pm2 startup
```

`pm2 startup` prints a command that installs a system service to run pm2 itself on boot. Run that command.

`pm2 logs pulchowk-events-bot` tails output. `pm2 restart pulchowk-events-bot` after edits. `pm2 stop pulchowk-events-bot` for clean shutdown.

### What NOT to do

Do not run the bot under `nohup ... &` or `screen`/`tmux` alone. Those survive a terminal close, but not a crash or reboot. They're fine for a temporary test; not for a 24/7 deployment.

---

## Configuration reference

Three config layers, all loaded at boot:

1. **`.env`** — secrets and deployment identifiers. Read via [`src/config/env.js`](../src/config/env.js), validated at startup.
2. **`src/config/constants.js`** — behavioral tunables. Read-only at process start (except where the code explicitly reads from `cache.settings` at runtime, which overrides).
3. **`src/config/emojis.js`** and **`src/config/roles.js`** — server-specific IDs (emoji assets, hardcoded ping roles). Edit these files when forking to a different Discord server.

### `.env` keys

Required for full function — the bot logs a warning at boot for each missing value:

| Var | Purpose | Notes |
|---|---|---|
| `DISCORD_TOKEN` | Bot token | Bot won't log in without it. |
| `HOME_GUILD_ID` | The one guild the bot responds in | All commands are guild-scoped to this. Without it, `/scrape`, `/pending`, `/shutdown` refuse in every guild. |
| `LOGS_CHANNEL_ID` | Curated human-facing feed (scrape progress, post results, recoveries) | Falls back to console-only if unset. |
| `AUDIT_LOG_CHANNEL_ID` | Exhaustive audit trail mirror | The local `audit-log.jsonl` is still written regardless; this only affects the Discord mirror. |

Channel IDs (one per category — 18 total, 9 main + 9 test):

| Main | Test |
|---|---|
| `SPORTS_CHANNEL_ID` | `TEST_SPORTS_CHANNEL_ID` |
| `SOFTWARE_CHANNEL_ID` | `TEST_SOFTWARE_CHANNEL_ID` |
| `HARDWARE_CHANNEL_ID` | `TEST_HARDWARE_CHANNEL_ID` |
| `GAMING_CHANNEL_ID` | `TEST_GAMING_CHANNEL_ID` |
| `MUSIC_CHANNEL_ID` | `TEST_MUSIC_CHANNEL_ID` |
| `BUSINESS_CHANNEL_ID` | `TEST_BUSINESS_CHANNEL_ID` |
| `MISC_CHANNEL_ID` | `TEST_MISC_CHANNEL_ID` |
| `JOBS_CHANNEL_ID` | `TEST_JOBS_CHANNEL_ID` |
| `SCHOLARSHIPS_CHANNEL_ID` | `TEST_SCHOLARSHIPS_CHANNEL_ID` |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `ALERTS_CHANNEL_ID` | — | Source-failure alert destination. Falls back to audit-log-only if unset. |
| `ALERTS_PING_ROLE_ID` | — | Role to ping on alerts. If unset, alerts post without a ping. |
| `JOBS_PING_ROLE_ID` | — | Role pinged on live job posts. `null` = no ping. |
| `SCHOLARSHIPS_PING_ROLE_ID` | — | Role pinged on live scholarship posts. `null` = no ping. |
| `WEB_PORT` | `3001` | Express dashboard API port. |
| `DASHBOARD_API_KEY` | — | If set, mutating `/api/*` routes require `X-API-Key: <key>`. Unset = those routes are unauthenticated. **Set this in production.** |
| `DASHBOARD_ALLOWED_ORIGINS` | — | Comma-separated list of origins for CORS. Unset = open CORS (any origin allowed). **Set this in production.** |
| `BROWSER_EXECUTABLE_PATH` | — | Windows only. Path to Brave/Chrome binary. Used by scrapers so they launch from a real browser profile rather than bundled Chromium. |
| `BROWSER_USER_DATA_DIR` | — | Windows only. Path to the browser profile (e.g. `C:/Users/you/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile 9`). |
| `SCRAPE_CRON` | `0 */6 * * *` | Default scrape schedule (5-field cron). Overridable at runtime via `/settings set-schedule`. |

**Role-ID values** — the three role vars (`ALERTS_PING_ROLE_ID`, `SCHOLARSHIPS_PING_ROLE_ID`, `JOBS_PING_ROLE_ID`) accept both forms:

- raw snowflake: `123456789012345678`
- mention-wrapped: `<@&123456789012345678>`

The bot normalizes either form on read. If you paste the full right-click "Copy Role ID" output from some Discord clients that include the mention wrapper, the bot unwraps it and renders a single ping. It also rejects anything that isn't a valid snowflake after normalization (no accidental pings from copy-paste garbage).

Supabase — bot archival:

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Bot archival project URL (e.g. `https://abc.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role JWT (starts `eyJ...`, 100+ chars) |
| `SUPABASE_EVENTS_TABLE` | Default `events`. Jobs share this table via a `type` column. |
| `SUPABASE_SCHOLARSHIPS_TABLE` | Default `scholarships`. |
| `SUPABASE_AUTOSYNC_INTERVAL_MINUTES` | Default `60`. |
| `SUPABASE_UPSERT_BATCH_SIZE` | Default `500`. Rows per upsert call. |

Supabase — website sync:

| Var | Purpose |
|---|---|
| `WEBSITE_SUPABASE_URL` | Public site project URL |
| `WEBSITE_SUPABASE_SERVICE_ROLE_KEY` | Service-role JWT |
| `WEBSITE_SYNC_ENABLED` | Default `true`. Set to `false` to disable entirely. |
| `WEBSITE_SYNC_DRY_RUN` | Default `false`. Set to `true` to log what *would* sync without writing. |
| `WEBSITE_EVENTS_TABLE` | Default `events`. |
| `WEBSITE_JOBS_TABLE` | Default `jobs`. |
| `WEBSITE_JOBS_SYNC_ENABLED` | Default `true`. Set to `false` to skip job sync. |
| `WEBSITE_SYNC_BATCH_SIZE` | Default `50`. |
| `WEBSITE_SYNC_BATCH_DELAY_MS` | Default `200`. Pause between batches. |
| `WEBSITE_SYNC_CRON` | Default `0 * * * *`. Hourly safety net. |
| `WEBSITE_REVALIDATE_URL` | Optional. On-demand ISR webhook URL. |
| `WEBSITE_REVALIDATE_SECRET` | Secret for `X-Revalidate-Secret` header. |

Everything after this section assumes `.env` is populated. The setup wizard (`node scripts/setup/index.js`) can generate `.env` interactively — see [Setup wizard](#setup-wizard).

### Server-specific config files

**`src/config/roles.js`** — ping role IDs for the 7 hardcoded categories (sports, software, hardware, gaming, music, business, miscellaneous). Jobs and scholarships read from `.env` instead. When forking the bot to a new Discord server, edit this file to match that server's roles.

**`src/config/emojis.js`** — all custom emoji asset references. Emoji IDs are server-specific; every `<:name:1234...>` reference in this file breaks on a server that didn't upload that emoji. Fork protocol: right-click each emoji in your Discord → Copy ID → paste into `emojis.js`.

If a fork skips this step, event messages will show literal `<:sagename:123...>` text instead of emoji. Ugly but not broken.

---

## Tuning constants

Read-only at boot, most overridable at runtime via `/settings`. Located in [`src/config/constants.js`](../src/config/constants.js).

### Timeouts and windows

| Constant | Default | What it does | Runtime override |
|---|---|---|---|
| `TARGET_TIMEZONE` | `Asia/Kathmandu` | All date math anchors here | No |
| `AUTOPOST_LIVE_WINDOW_START_HOUR` | `6` | Live autopost won't fire before this hour | No |
| `AUTOPOST_LIVE_WINDOW_END_HOUR` | `22` | Live autopost won't fire after this hour | No |
| `AUTOPOST_IDLE_RETRY_MS` | `30000` | At `interval_minutes: 0`, wait this long between idle ticks | No |
| `STALE_RESERVATION_MS` | `90000` | Marker reservations older than this get Discord-verified | No |
| `MISSED_SCRAPE_LOG_THROTTLE_MS` | `1800000` | Cap on "missed scrape detected" Discord message rate | No |

### Dedup

| Constant | Default | What it does | Runtime override |
|---|---|---|---|
| `FUZZY_TITLE_SIMILARITY_THRESHOLD` | `0.85` | Levenshtein similarity threshold for events/jobs | No |
| `SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD` | `0.93` | Stricter threshold for scholarships (titles share boilerplate) | No |

### Queue behavior

| Constant | Default | What it does | Runtime override |
|---|---|---|---|
| `DEFAULT_AUTOPOST_MIN_LEAD_DAYS` | `3` | Minimum days until event date for autopost to consider it | `/settings set-lead-days` |
| `DEFAULT_NEEDS_ATTENTION_EXPIRY_DAYS` | `14` | Days a stuck item sits in pending before archival | `/settings set-needs-attention-expiry-days` |
| `MARKER_RETENTION_MS` | `180 days` | How long confirmed markers are kept before daily cleanup | No |
| `CACHE_CAP` | `1000` | Max entries per cache array | No |

### Alerts

| Constant | Default | What it does | Runtime override |
|---|---|---|---|
| `DEFAULT_SOURCE_ALERT_THRESHOLD` | `3` | Consecutive failures before alerting | No (config not currently exposed) |
| `DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES` | `60` | Min gap between alerts for the same source | No (config not currently exposed) |

Changing constants in `constants.js` requires restarting the process. Changing anything via `/settings` is instant.

---

## Monitoring

The bot's operational state lives in three places: `data/audit-log.jsonl`, `data/cache.json`, and the Discord logs channel.

### What to check daily

**1. Scrape health.** Every scrape run logs a `scrape_all_complete` entry:

```bash
tail -200 data/audit-log.jsonl | jq -r 'select(.category=="scrape_all_complete") | "\(.timestamp)\t\(.message)"' | tail -5
```

Expected: at least one entry per active scrape cron (every 6 hours by default). If the last entry is >12 hours old, the bot is stale or down.

**2. Source verdicts.** Every source reports its outcome:

```bash
tail -1000 data/audit-log.jsonl | jq -r 'select(.category=="scrape_all_complete") | .data.perSource | to_entries[] | "\(.key)\t\(.value.verdict)\t\(.value.itemCount)"' | sort | uniq -c
```

Expected: mostly `ok` verdicts. Any `dom_drift_*`, `blocked`, or repeated `empty` needs investigation.

**3. Source-failure streaks.** Alert state per source:

```bash
node -e "
const EventsBot = require('./src/bot');
const bot = new EventsBot();
const snap = require('./src/scrapers/alerts').getAlertSnapshot(bot);
for (const s of snap) console.log(s.source, 'failures:', s.consecutiveFailures, 'last alert:', s.lastAlertAt ? new Date(s.lastAlertAt).toISOString() : 'never');
"
```

Sources with `consecutiveFailures >= 3` are actively broken. Investigate with `node scripts/verify-source.js <name>`.

**4. Post failures.** Every failed post logs its reason:

```bash
tail -500 data/audit-log.jsonl | jq -r 'select(.category=="post_event_outcome" and .data.ok==false) | "\(.timestamp)\t\(.data.title)\t\(.data.reason)"' | tail -20
```

Common reasons and what they mean:

- `already_posted` — dedup caught a duplicate. This is the system working correctly, not a bug.
- `no_image` — live gate blocked an imageless item. Post to Test, or add an image via Customize.
- `data_quality_warning` — live gate blocked a flagged item. Fix the field via Customize, or force-post.
- `category_paused` — a `/category pause` is active.
- `send_failed` — actual Discord API error. Check `discord_api_error` entries for the full trace.

**5. Marker consistency.** The daily maintenance cron (3 AM by default) runs `consistency_check`:

```bash
tail -1000 data/audit-log.jsonl | jq -r 'select(.category=="consistency_check") | "\(.timestamp)\t\(.message)"' | tail -3
```

Expected: `No discrepancies between cache.postedEvents and marker files`. Discrepancies require investigation but aren't urgent — they usually reflect a very rare crash-recovery scenario and the next startup reconciliation will resolve them.

### What to check when something feels wrong

**"Nothing is posting."** In order:

```bash
# Is the bot still running?
ps -ef | grep "node src/index.js" | grep -v grep

# Is autopost actually active?
node -e "const b = new (require('./src/bot'))(); console.log(JSON.stringify(b.autopostConfig, null, 2));"

# What's in the pending queue?
node -e "const b = new (require('./src/bot'))(); console.log('pending:', b.cache.pendingEvents.length, 'posted:', b.cache.postedEvents.length);"

# Why is autopost skipping?
tail -100 data/audit-log.jsonl | jq -r 'select(.category=="autopost_filter_skip") | "\(.data.title)\t\(.data.filter)"' | tail -20
```

The last command is the most useful. Filter names:
- `past_filter` — event date is in the past
- `too_soon_filter` — event is < `autopostMinLeadDays` away
- `has_image_filter` — item has no valid image (live only)

**"The bot is posting duplicates."** This should be impossible with the marker system, but if it happens:

```bash
# Count markers for a title
grep -l "target title" data/posted-channel-markers/*.json | wc -l

# What's in the marker?
grep -l "target title" data/posted-channel-markers/*.json | head -1 | xargs cat | jq .
```

If the marker exists with `postedAt` but the item was still re-posted, that's a marker-path bug (the second post didn't find the first marker). File it — that's a real code issue.

If the marker has a `reservedAt` but no `postedAt`, and it's older than 90 seconds, the marker is stale — reconciliation should have kicked in. Check `discord_reconciliation` entries for the story.

**"A source is producing 0 items."** Run `node scripts/verify-source.js <name>`. Match the verdict to a fix:

- `dom_drift_listing` → listing selectors stale
- `dom_drift_detail` → detail selectors stale
- `blocked` → captcha / Cloudflare, needs warm browser profile
- `empty` → site genuinely has nothing
- `parse_failed` → runtime error, check console

See [`scrapers.md`](scrapers.md) for the full drift playbook.

**"The website is out of sync with Discord."**

```bash
# In Discord
/website-sync health
/website-sync now  # to reconcile
```

The health command diffs the bot's eligible set against the website's rows. `missing` = should be on the site but isn't. `orphans` = on the site but shouldn't be. Both get reconciled by `now`.

**"Autopublish isn't crossposting new live posts."** The wrap fires on every successful live post, but only crossposts if the target channel is an Announcement channel and the just-posted message wasn't removed by the dedupe sweep. Check:

```bash
# Was autopublish even attempted?
tail -100 data/audit-log.jsonl | jq -r 'select(.category | test("autopublish")) | "\(.timestamp)\t\(.category)\t\(.message)"' | tail -20
```

What you might see:

- **`autopublish — Crossposted <messageId> in <channelId>`** — working correctly.
- **`autopublish_skipped` with `reason: not_crosspostable`** — the channel is a plain text channel, not an Announcement channel. Fix in Discord: Channel Settings → Overview → Channel Type → Announcement. Text channels cannot be crossposted; this isn't a bot bug.
- **`autopublish_skipped` with `reason: was_duplicate`** — the just-posted message was removed by the immediately-preceding dedupe sweep as a duplicate of an older message. The older one is already out; nothing to publish. This is the correct guard against re-publishing duplicates.
- **`autopublish_error`** — `message.crosspost()` threw. Usually rate limiting. The error payload names the Discord error code.
- **No `autopublish*` entries at all** — either `autopublishEnabled` is false (`/autopublish status`), or the post wasn't a live post (test-mode posts never trigger autopublish), or the extension didn't attach (check boot log for `🧩 [ext] Attached N command(s)`).

---

## Backups

The bot's entire state is in `data/`. Three files matter:

| File | Contains | Can be regenerated? |
|---|---|---|
| `data/cache.json` | pending/posted/skipped/expired events, settings | **No** — losing it means re-scraping everything and re-posting it |
| `data/posted-channel-markers/` | authoritative "was this posted" truth | **No** — losing it means re-posting previously-posted items |
| `data/audit-log.jsonl` | forensic record | No, but it's append-only and less critical |

Back them up together, on a schedule. Simplest reliable approach: a daily cron on the same host.

```bash
# /etc/cron.daily/pulchowk-events-backup
#!/bin/bash
set -e
BACKUP_DIR=/var/backups/pulchowk-events
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cd /path/to/repo
tar -czf "$BACKUP_DIR/data-$STAMP.tar.gz" data/cache.json data/posted-channel-markers

# Keep 30 days
find "$BACKUP_DIR" -name 'data-*.tar.gz' -mtime +30 -delete
```

Restore procedure: stop the bot, extract the tarball over `data/`, start the bot. Startup reconciliation will fix any inconsistency between the restored cache and any newly-created markers.

`/backup` in Discord downloads `cache.json` on demand — useful before a migration or a big cleanup operation, but not a scheduled-backup replacement.

---

## Migration from a legacy deployment

If the bot previously ran with `cache.json`, `posted-channel-markers/`, and `audit-log.jsonl` at the repo root (pre-`data/` layout), the migration script moves them into `data/` without touching the source.

```bash
# Stop the bot first
node scripts/maintenance/migrate-from-legacy.js --from /path/to/old/repo --dry-run
```

The dry-run prints every file it will copy, every cache array it will migrate, and the marker count. It does **not** modify anything.

If the counts match what you expect:

```bash
node scripts/maintenance/migrate-from-legacy.js --from /path/to/old/repo
```

The script:

- Copies (never moves) `cache.json`, `audit-log.jsonl`, and every marker file
- Aborts if `data/cache.json` already exists and is non-trivial (>100 bytes) — prevents accidentally overwriting a live installation's cache
- Backs up any existing `data/cache.json` before writing
- Exits cleanly with a summary

**After migration, the old repo is unaffected.** Its `cache.json` and markers still live at the original paths. Only the new bot reads `data/`. This is deliberate — if the new bot has a problem, you can shut it down and restart the old one with no data loss.

Boot the new bot, check the log for:

```
✅ Bot logged in as ...
✅ Slash commands registered to guild ...
🌐 Website sync starting (mode: LIVE)
```

Then run `/status` in Discord. Expected: `pending`, `posted`, `skipped` counts matching the source cache. `lastCheck` should be a recent timestamp (from the source cache). First scrape will update it.

Verify no re-posting happened: the first full scrape after migration should produce no new items (all dedup keys already in `postedEventKeys`) and no `post_event_outcome` successes for items that were previously posted.

---

## Setup wizard

For a fresh deployment from zero. If you already have a working `.env`, skip this.

```bash
# Walk the flow with mock data (never touches .env, Discord, or Supabase)
node scripts/setup/index.js --demo

# Real setup
node scripts/setup/index.js
```

The wizard is interactive, requires a TTY, and never writes `.env` without showing you a diff and asking for confirmation.

**Steps:**

1. **Open prerequisite docs.** Prompts to open Discord Developer Portal, Supabase Dashboard, and Node.js downloads. Optional.
2. **Discord token.** Prompts for a bot token. Validates 3-segment structure.
3. **Guild selection.** Lists every guild the bot is a member of. Prompts to pick one. Verifies the bot has `ManageChannels` / `ManageRoles` in that guild.
4. **Category channels.** For each of the 9 categories, prompts either "pick an existing channel" (lists them) or "create one" (asks for a name, creates via `guild.channels.create()`). 18 channels total — main and test per category.
5. **Logs / audit / alerts channels.** Same pick-or-create flow for the three operational channels.
6. **Ping roles.** For each of 9 categories, prompts pick-or-create for its ping role. 7 hardcoded, 2 written to `.env` (`JOBS_PING_ROLE_ID`, `SCHOLARSHIPS_PING_ROLE_ID`).
7. **Supabase — bot archival.** Prompts for URL + service_role key. Tests connection. If any table is missing, offers to copy the `CREATE TABLE` SQL and open the Supabase SQL editor.
8. **Supabase — website.** Same flow, different project.
9. **Dashboard.** Generates a random `DASHBOARD_API_KEY`, sets `DASHBOARD_ALLOWED_ORIGINS` to `http://localhost:6234`.
10. **Browser profile (optional).** Prompts for Brave/Chrome executable path and user data directory. Windows only; safely skippable on Linux.
11. **Write `.env`.** Shows diff (added keys, updated keys, unchanged). Confirms before writing. Backs up existing `.env` to `.env.bak.<timestamp>`.
12. **Boot test (real mode only).** Launches `node src/index.js` in a 15-second child process, checks for "Bot logged in as". Does not disturb the currently-running bot.

**Demo mode differs in three ways:**

- Uses mock Discord and Supabase adapters (no real API calls)
- Writes to `data/demo-setup.env` instead of `.env`
- Skips the boot test

Use demo mode to train the flow, or to inspect the wizard before running it on a real deployment.

**Undo:** delete `.env` (or restore from `.env.bak.<timestamp>`), then delete any channels/roles the wizard created. The wizard doesn't tag anything, so identify its output by name — `⚽┃sports`, `💼┃jobs-internships`, etc. — matching the defaults in `CATEGORY_SPEC`.

---

## Troubleshooting

Symptom-indexed. Each entry: what you see → diagnostic command → resolution.

### "Bot won't start"

```bash
node src/index.js 2>&1 | head -30
```

Look for:
- `Cannot find module ...` → `npm install` not run, or the missing module is a broken require path
- `DISCORD_TOKEN is not set` → `.env` missing or wrong path
- `HOME_GUILD_ID is not set` → commands will refuse globally until set
- `Error: Cannot find module './discord/onReady'` → half-deleted install, re-clone
- `login failed: An invalid token was provided` → stale token, reset via Developer Portal

### "Bot logs in but slash commands don't appear"

- Check `HOME_GUILD_ID` in `.env` matches the guild you're testing in
- Run `/status` — if it works, commands registered
- Commands can take up to 60 seconds to propagate after a fresh registration
- If still missing after 2 min: check console for `❌ Failed to register slash commands` — usually a permissions issue (bot needs `applications.commands` scope)

### "Slash commands appear in a guild OTHER than HOME_GUILD_ID"

That's a bug, not intended behavior. Every command — base, extension, `/supabase`, `/website-sync` — should be guild-scoped to `HOME_GUILD_ID` and nowhere else. If they show up in a foreign guild, the admin gate still blocks them from *working* there, but they shouldn't even be visible.

Check the boot log for these four lines:

```
✅ Slash commands registered to guild <ID> only (N command(s)).
✅ [ext] Registered N extension command(s) to guild <ID> only.
✅ [supabase] Registered N command(s) to guild <ID> only.
✅ [websiteSync] Registered N command(s) to guild <ID> only.
```

Every one must end with `to guild <ID> only`. If any of them says `Registered N command(s).` without that suffix, that module fell back to `Routes.applicationCommands` (global). That's a code regression — the registration path in that file uses `Routes.applicationGuildCommands` and the fix is to restore it. File an issue with the log line.

### "0 items scraped"

```bash
node scripts/verify-source.js <name>
```

Match the verdict to a fix. Full playbook in [`scrapers.md`](scrapers.md#when-a-source-drifts). The most common cause is selector drift — the site changed its DOM and the extractor's `pickOne`/`pickAll` chain didn't catch it.

### "Post failed: no_image"

Live posts require a valid image URL. Scholarships are exempt.

- Open `/pending`, find the item, click **Customize**, paste a valid image URL
- Or click **Post to Test** to skip the live gate

### "Post failed: data_quality_warning"

The item has unresolved field-level issues ("date" containing an emoji, "price" containing a category name, etc). The warning text names the field.

- Open `/pending`, find the item, click **Customize**, fix the flagged field
- Or click **Post to Test** to bypass the live gate (test posts don't check warnings)
- Or force-post with the `/pending` confirm step (the "Yes, post it anyway" button)

### "Autopost keeps saying 'nothing eligible'"

The idle log throttles to once per 5 minutes. Check the audit log for the actual reasons:

```bash
tail -100 data/audit-log.jsonl | jq -r 'select(.category=="autopost_filter_skip") | "\(.data.title)\t\(.data.filter)"' | tail -20
```

If the last entry is >5 minutes old, autopost may not be active. Check `/autopost status`.

### "Live posts stopped after 10 PM"

Correct behavior. Live autopost is capped to 6 AM–10 PM Nepal time because live posts ping roles. Test autopost has no such window.

To override, edit `AUTOPOST_LIVE_WINDOW_*_HOUR` in `src/config/constants.js` and restart.

### "cache.json was corrupted"

The bot quarantines corrupt caches automatically:

```bash
ls data/cache.json.bak.*
```

Pick the most recent backup, restore it:

```bash
cp data/cache.json.bak.<timestamp> data/cache.json
npm start
```

The `cache_corruption_fallback` audit entry names the quarantine path. If the corrupt file has valid content but one bad byte, `jq . data/cache.json.bak.<ts>` may still parse it — in that case you can fix the byte and restore.

### "Bot is in multiple guilds but only responds in one"

Correct behavior. `HOME_GUILD_ID` gates every command and every interaction. Adding the bot elsewhere grants no access. This is what stops someone adding the bot to a foreign server and running `/shutdown`.

If the bot IS responding in a foreign guild, that's a real bug — check `unauthorized_guild` audit entries.

### "Website sync says 'Prune ABORTED'"

The website sync has two prune guards, both fire warnings when tripped:

- `empty_eligible_set` — 0 eligible items but existing rows in the target table. Almost always a scrape failure upstream. Check the last scrape's per-source verdicts.
- `delete_threshold_exceeded` — >50% of bot-origin rows would be pruned. A scrape probably returned a wrong-shaped set. Verify with `/website-sync health`.

Neither guard is a failure — both are refusals to delete, which is the correct response. Investigate what caused the anomalous set, fix, then re-sync.

### "Website sync runs but nothing reaches the site"

Eligible item gates:

- `hasValidImage` — no image → excluded
- data-quality warnings — flagged → excluded
- blacklisted — matches `/blacklist` rules → excluded
- user-collision — a user-submitted event on the same date shares at least one substantive word (≥4 chars, word-boundary, not a stopword like "nepal"/"the"/"event") with the bot event → excluded. Titles that share only stopwords or only short common words like "AI" do NOT collide.

Run `/website-sync health` to see the counts. If `expected` is much higher than `existing`, gates are filtering aggressively. Check `/pending` for flagged items.

### "A source-failure alert arrived"

The alert means: this source has returned non-`ok` verdicts N scrapes in a row (default 3), where N ≥ `DEFAULT_SOURCE_ALERT_THRESHOLD`.

What to do:

```bash
# Identify the source from the alert text
# Run the diagnostic
node scripts/verify-source.js <source-name>
```

The verdict matches the alert's `Why:` line. Follow the corresponding fix in [`scrapers.md`](scrapers.md#when-a-source-drifts).

Alerts have a 60-minute cooldown per source — an ongoing outage won't re-ping more than once per hour. The audit log records every failure, but the Discord alert is throttled to avoid noise during an extended outage.

If the alert arrives but `verify-source.js` returns `verdict: ok` — the source may have recovered. Check the actual scrape log:

```bash
grep '<source-name>' data/audit-log.jsonl | tail -5 | jq .
```

### "The bot is looping, posting the same item repeatedly"

This should be impossible. The marker file is the guarantee. If it happens:

1. Stop the bot immediately
2. Check the markers for the looping item's title:

```bash
grep -l "title snippet" data/posted-channel-markers/*.json
```

3. If no markers exist for that (title, channel) pair, the post is failing at the reserve step — check `reserve_posted_marker` audit entries.
4. If markers exist but posts still go out, the marker-path computation is producing different hashes on each call — that's a real code bug (dedup key not stable across calls), file it with the audit trail.

### "The pending queue keeps growing but nothing gets posted"

Two causes:

1. **Gates are rejecting.** Check `post_event_outcome` audit entries for `reason` distribution:

```bash
tail -1000 data/audit-log.jsonl | jq -r 'select(.category=="post_event_outcome" and .data.ok==false) | .data.reason' | sort | uniq -c | sort -rn
```

If most failures are the same reason (`no_image`, `data_quality_warning`), that's the actual problem — items are being scraped badly, not failing to post.

2. **Autopost isn't running.** Check `/autopost status`. All tracks off = nothing will post automatically; `/pending` manual posting still works.

### "/undo says 'Couldn't locate the live message'"

Expected refusal, not a bug. `handleUndo` refuses when it can't find the live message in either:
- `bot._ext.recentPosts` — the in-memory registry of the last 20 live posts (lost on restart)
- a scan of the last 25 messages per live channel (missed if the message has since drifted out of the window)

Reverting the cache here would strand the item: it would move back to `pending`, but its marker at the original channel would still be confirmed, so the next post attempt would see `already_posted` and refuse. The bot refuses the undo cleanly instead of silently creating a zombie.

Three options, in order of preference:

- **`/edit-live query:"<title>"`** — edit the existing live message in place (same title-match rules, but no cache mutation on failure)
- **`/cleanup item_type:<type>`** — force-remove from cache (drops the marker too, allowing a clean re-post)
- **Manually delete the Discord message in the channel**, then retry `/undo` — this clears the scanned-channel state so the undo can proceed normally

---

## Alerts

Source-failure alerts are a separate subsystem from the audit log.

**What fires them:** a source has returned non-`ok` verdicts for `DEFAULT_SOURCE_ALERT_THRESHOLD` consecutive scrapes (default 3). Non-`ok` means: `blocked`, `dom_drift_listing`, `dom_drift_detail`, `empty`, `parse_failed`, `extractor_not_implemented`. Note that `empty` is included — a source that goes from posting 15 items to 0 consistently is a failure, not "the site has no events."

**What un-fires them:** a single `ok` verdict resets the streak to 0. No waiting, no aging-out.

**What they say:** source name, type, streak count, threshold, one-line reason, and the last verdict status. If `ALERTS_PING_ROLE_ID` is set, they also ping that role.

**Cooldown:** 60 minutes per source. Once an alert has fired, that source won't alert again for 60 minutes even if the streak keeps growing. Every failure is still logged to `audit-log.jsonl` regardless — the cooldown only throttles the Discord ping.

**Configuration:**

- `ALERTS_CHANNEL_ID` — destination channel. Unset = alerts only go to `audit-log.jsonl`, no Discord ping.
- `ALERTS_PING_ROLE_ID` — role to ping. Unset = alert posts without a ping. Accepts raw snowflake or `<@&...>` wrapper.
- `DEFAULT_SOURCE_ALERT_THRESHOLD` in `constants.js` — streak count. Default 3.
- `DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES` in `constants.js` — cooldown. Default 60.

**When one arrives:** treat it as a paging-level signal. Run `node scripts/verify-source.js <source>`. If it's `blocked`, that's often transient (Cloudflare had a bad moment) — wait an hour and re-check. If it's `dom_drift_*`, the source needs a fix — schedule it. If it's `empty`, investigate whether the site changed or is genuinely between events.

**What they are NOT:** alerts for individual post failures, data-quality warnings, or transient Discord API errors. Those go to `audit-log.jsonl` and (for some) the logs channel. Alerts are specifically for source-level problems that need human attention.

---

## Log rotation

Three log surfaces, each with its own rotation behavior.

### `data/audit-log.jsonl`

Rotates automatically at 5000 lines or 5 MB, whichever comes first. On rotation, keeps the most recent 5000 entries and drops the rest. No archive is created — the design philosophy is "the audit log is a rolling window of recent activity, not a permanent record."

For permanent retention: `/backup` downloads `cache.json`, not the audit log. If you need historical audit data, periodically copy `data/audit-log.jsonl` to an archive location before it rotates.

### Discord logs channel

Rotates naturally — Discord's own message history is the rotation. No code-level management; the channel just accumulates. If it grows too noisy, archive it periodically (Discord supports archiving to a new channel).

The logs channel is separate from the audit channel. Logs = human-facing curated feed. Audit = exhaustive record mirror (which also truncates each entry to 1500 chars in the Discord embed — the local file has the full entry).

### `data/cache.json`

Not a log, but rotation-adjacent: capped at 1000 entries per array (`pendingEvents`, `postedEvents`, `skippedEvents`, `expiredEvents`, `needsAttentionExpiredEvents`). When an array exceeds the cap, the oldest entries are silently dropped. This is why `republish-all` can only re-upload the most recent 1000 posted items, not the entire history.

### Console output / supervisor logs

The bot writes to stdout and stderr liberally — scrape progress, per-item extraction logs, error traces. Under systemd this goes to `journalctl`; under Task Scheduler it goes to whatever file you redirected to; under pm2 it goes to `pm2 logs`.

None of this is persisted by the bot itself. Rotation is entirely the supervisor's responsibility:

- systemd: `journalctl --vacuum-time=30d` on a monthly cron
- Task Scheduler / file redirect: `logrotate` equivalent, or truncate the file periodically
- pm2: `pm2 install pm2-logrotate` provides automatic rotation

The bot doesn't care — it just writes; the supervisor handles retention.

### Marker files

`data/posted-channel-markers/*.json` — one file per (item, channel) pair, capped at `MARKER_RETENTION_MS` (180 days by default). A daily cron sweeps markers older than the retention window:

```bash
# Every day at 3 AM (piggybacked on the consistency check)
```

Markers within the retention window are authoritative — do not delete them manually. Deleting a marker means the bot will consider that (item, channel) pair as "never posted" and will re-post on the next scrape.

If markers need to be cleared for a specific reason (a test deployment, a recovery from a bad state), do it via `/undo` (which releases a single marker) or by stopping the bot and deleting marker files, then running the migration script with `--dry-run` first to understand what you're about to re-post.