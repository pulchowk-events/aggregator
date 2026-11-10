// src/config/env.js
// Single source of truth for environment configuration.
// Every other module imports from here rather than reading process.env
// directly, so a missing var can never silently become `undefined` deeper
// in the codebase — it's declared and validated in exactly one place.

const path = require('path');
const dotenv = require('dotenv');

// Load .env from the repo root (not from process.cwd(), which can vary
// depending on how node was invoked). Fail-soft: dotenv is a no-op if the
// file is absent (CI/production typically injects real env vars instead).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function optional(name, fallback = null) {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
}

function optionalInt(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
}

function optionalFloat(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
}

function optionalBool(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return v === 'true' || v === '1';
}

function optionalList(name) {
    const v = process.env[name];
    if (!v) return [];
    return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- Discord ----------
const DISCORD_TOKEN = optional('DISCORD_TOKEN');
const HOME_GUILD_ID = optional('HOME_GUILD_ID');
const LOGS_CHANNEL_ID = optional('LOGS_CHANNEL_ID');
const AUDIT_LOG_CHANNEL_ID = optional('AUDIT_LOG_CHANNEL_ID');
const EVENTS_DUMP_CHANNEL_ID = optional('EVENTS_DUMP_CHANNEL_ID');

// ---------- Web (dashboard API) ----------
const WEB_PORT = optionalInt('WEB_PORT', 3001);
const DASHBOARD_API_KEY = optional('DASHBOARD_API_KEY');
const DASHBOARD_ALLOWED_ORIGINS = optionalList('DASHBOARD_ALLOWED_ORIGINS');

// ---------- Category channels (main = live, test = staging) ----------
const CHANNELS = {
    sports:        { main: optional('SPORTS_CHANNEL_ID'),        test: optional('TEST_SPORTS_CHANNEL_ID'),        ping: '<@&1124916543864713322>' },
    software:      { main: optional('SOFTWARE_CHANNEL_ID'),      test: optional('TEST_SOFTWARE_CHANNEL_ID'),      ping: '<@&1124986979868745815>' },
    hardware:      { main: optional('HARDWARE_CHANNEL_ID'),      test: optional('TEST_HARDWARE_CHANNEL_ID'),      ping: '<@&1124986137031753758>' },
    gaming:        { main: optional('GAMING_CHANNEL_ID'),        test: optional('TEST_GAMING_CHANNEL_ID'),        ping: '<@&1124985995960533015>' },
    music:         { main: optional('MUSIC_CHANNEL_ID'),         test: optional('TEST_MUSIC_CHANNEL_ID'),         ping: '<@&1125055841834373292>' },
    business:      { main: optional('BUSINESS_CHANNEL_ID'),      test: optional('TEST_BUSINESS_CHANNEL_ID'),      ping: '<@&1125056110894792754>' },
    miscellaneous: { main: optional('MISC_CHANNEL_ID'),          test: optional('TEST_MISC_CHANNEL_ID'),          ping: '<@&1388075747679145994>' },
    jobs:          { main: optional('JOBS_CHANNEL_ID'),          test: optional('TEST_JOBS_CHANNEL_ID'),          ping: optional('JOBS_PING_ROLE_ID') },
    scholarships:  { main: optional('SCHOLARSHIPS_CHANNEL_ID'),  test: optional('TEST_SCHOLARSHIPS_CHANNEL_ID'),  ping: optional('SCHOLARSHIPS_PING_ROLE_ID') }
};

// ---------- Bot Supabase (posted-event archival) ----------
const SUPABASE_URL = optional('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = optional('SUPABASE_SERVICE_ROLE_KEY');
const SUPABASE_EVENTS_TABLE = optional('SUPABASE_EVENTS_TABLE', 'events');
const SUPABASE_JOBS_TABLE = optional('SUPABASE_JOBS_TABLE', 'jobs');
const SUPABASE_SCHOLARSHIPS_TABLE = optional('SUPABASE_SCHOLARSHIPS_TABLE', 'scholarships');
const SUPABASE_AUTOSYNC_INTERVAL_MINUTES = optionalInt('SUPABASE_AUTOSYNC_INTERVAL_MINUTES', 60);
const SUPABASE_UPSERT_BATCH_SIZE = optionalInt('SUPABASE_UPSERT_BATCH_SIZE', 500);

// ---------- Website Supabase (public site sync) ----------
const WEBSITE_SUPABASE_URL = optional('WEBSITE_SUPABASE_URL');
const WEBSITE_SUPABASE_SERVICE_ROLE_KEY = optional('WEBSITE_SUPABASE_SERVICE_ROLE_KEY');
const WEBSITE_SYNC_ENABLED = optionalBool('WEBSITE_SYNC_ENABLED', true);
const WEBSITE_SYNC_DRY_RUN = optionalBool('WEBSITE_SYNC_DRY_RUN', false);
const WEBSITE_EVENTS_TABLE = optional('WEBSITE_EVENTS_TABLE', 'events');
const WEBSITE_JOBS_TABLE = optional('WEBSITE_JOBS_TABLE', 'jobs');
const WEBSITE_JOBS_SYNC_ENABLED = optionalBool('WEBSITE_JOBS_SYNC_ENABLED', true);
const WEBSITE_SYNC_BATCH_SIZE = optionalInt('WEBSITE_SYNC_BATCH_SIZE', 50);
const WEBSITE_SYNC_BATCH_DELAY_MS = optionalInt('WEBSITE_SYNC_BATCH_DELAY_MS', 200);
const WEBSITE_SYNC_CRON = optional('WEBSITE_SYNC_CRON', '0 * * * *');
const WEBSITE_REVALIDATE_URL = optional('WEBSITE_REVALIDATE_URL');
const WEBSITE_REVALIDATE_SECRET = optional('WEBSITE_REVALIDATE_SECRET');

// ---------- Browser (optional custom executable/profile) ----------
const BROWSER_EXECUTABLE_PATH = optional('BROWSER_EXECUTABLE_PATH');
const BROWSER_USER_DATA_DIR = optional('BROWSER_USER_DATA_DIR');
const JOB_BROWSER_EXECUTABLE_PATH = optional('JOB_BROWSER_EXECUTABLE_PATH');
const JOB_BROWSER_USER_DATA_DIR = optional('JOB_BROWSER_USER_DATA_DIR');

// ---------- Misc ----------
const NEXTJS_SITE_URL = optional('NEXTJS_SITE_URL');
const CACHE_SAVE_DEBOUNCE_MS = optionalInt('CACHE_SAVE_DEBOUNCE_MS', 2000);
const MARKER_RETENTION_DAYS = optionalInt('MARKER_RETENTION_DAYS', 180);
const AUTOPOST_MIN_LEAD_DAYS = optionalInt('AUTOPOST_MIN_LEAD_DAYS', 3);
const NEEDS_ATTENTION_EXPIRY_DAYS = optionalInt('NEEDS_ATTENTION_EXPIRY_DAYS', 14);
const TEST_TO_LIVE_PROMOTION_DELAY_MINUTES = optionalInt('TEST_TO_LIVE_PROMOTION_DELAY_MINUTES', 30);
const TEST_TO_LIVE_PROMOTION_SWEEP_CRON = optional('TEST_TO_LIVE_PROMOTION_SWEEP_CRON', '*/5 * * * *');
const SCRAPE_CRON = optional('SCRAPE_CRON', '0 */6 * * *');

// ---------- Config validation ----------
// Returns an array of human-readable warnings; never throws.
// Callers (bot.js) surface these at startup instead of failing hard, so a
// half-configured dev box can still boot into a diagnostic state.
function validateConfig() {
    const problems = [];
    if (!DISCORD_TOKEN) problems.push('DISCORD_TOKEN is not set — the bot cannot log in.');
    if (!HOME_GUILD_ID) problems.push('HOME_GUILD_ID is not set — the bot will refuse ALL admin commands in every guild until this is set.');
    if (!LOGS_CHANNEL_ID) problems.push('LOGS_CHANNEL_ID is not set — scrape logs will have nowhere to go until you set it via /settings set-logs.');
    if (!AUDIT_LOG_CHANNEL_ID) problems.push('AUDIT_LOG_CHANNEL_ID is not set — the audit trail will only be written to the local audit-log.jsonl file, not to Discord.');

    for (const [key, cat] of Object.entries(CHANNELS)) {
        if (!cat.main && !cat.test) {
            problems.push(`Category "${key}" has no main or test channel ID configured — events in this category cannot be posted.`);
        }
    }

    if (!DASHBOARD_API_KEY) problems.push('DASHBOARD_API_KEY is not set — mutating /api/* routes are UNAUTHENTICATED.');
    if (DASHBOARD_ALLOWED_ORIGINS.length === 0) problems.push('DASHBOARD_ALLOWED_ORIGINS is not set — the dashboard API accepts cross-origin requests from ANY origin.');

    return problems;
}

module.exports = {
    DISCORD_TOKEN,
    HOME_GUILD_ID,
    LOGS_CHANNEL_ID,
    AUDIT_LOG_CHANNEL_ID,
    EVENTS_DUMP_CHANNEL_ID,

    WEB_PORT,
    DASHBOARD_API_KEY,
    DASHBOARD_ALLOWED_ORIGINS,

    CHANNELS,

    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_EVENTS_TABLE,
    SUPABASE_JOBS_TABLE,
    SUPABASE_SCHOLARSHIPS_TABLE,
    SUPABASE_AUTOSYNC_INTERVAL_MINUTES,
    SUPABASE_UPSERT_BATCH_SIZE,

    WEBSITE_SUPABASE_URL,
    WEBSITE_SUPABASE_SERVICE_ROLE_KEY,
    WEBSITE_SYNC_ENABLED,
    WEBSITE_SYNC_DRY_RUN,
    WEBSITE_EVENTS_TABLE,
    WEBSITE_JOBS_TABLE,
    WEBSITE_JOBS_SYNC_ENABLED,
    WEBSITE_SYNC_BATCH_SIZE,
    WEBSITE_SYNC_BATCH_DELAY_MS,
    WEBSITE_SYNC_CRON,
    WEBSITE_REVALIDATE_URL,
    WEBSITE_REVALIDATE_SECRET,

    BROWSER_EXECUTABLE_PATH,
    BROWSER_USER_DATA_DIR,
    JOB_BROWSER_EXECUTABLE_PATH,
    JOB_BROWSER_USER_DATA_DIR,

    NEXTJS_SITE_URL,
    CACHE_SAVE_DEBOUNCE_MS,
    MARKER_RETENTION_DAYS,
    AUTOPOST_MIN_LEAD_DAYS,
    NEEDS_ATTENTION_EXPIRY_DAYS,
    TEST_TO_LIVE_PROMOTION_DELAY_MINUTES,
    TEST_TO_LIVE_PROMOTION_SWEEP_CRON,
    SCRAPE_CRON,

    validateConfig
};
