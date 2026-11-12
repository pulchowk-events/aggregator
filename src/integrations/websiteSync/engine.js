// src/integrations/websiteSync/engine.js
// The website Supabase sync engine.
//
// Public site has its own Supabase (browser-client key, curated subset).
// Two tables: events + jobs. Both are populated from the bot's cache —
// pending + posted — filtered through quality gates, upserted in batches,
// pruned against orphans, with safety guards that abort destructive
// operations on anomalous signals.
//
// Gates (events):
//   - itemType must be undefined (i.e. not job, not scholarship)
//   - hasValidImage
//   - no data-quality warnings
//   - not matched by the blacklist
//   - not collided with a user-submitted event on the same date
//
// Gates (jobs):
//   - itemType === 'job'
//   - hasValidImage
//   - no data-quality warnings
//   - not blacklisted
//   - NOT expired (deadline known and past) — but explicitly DO NOT
//     apply the too-soon gate: an urgent job is urgent, not too late.
//
// Both computeEligible functions dedupe by dedup key, preferring POSTED
// over PENDING on collision (posted means we already showed it in Discord,
// so the site should reflect it).

const crypto = require('crypto');
const { auditLog } = require('../../core/auditLogger');
const { normalizeScholarshipToEventShape } = require('../../core/shape');
const env = require('../../config/env');

const WEBSITE_URL = env.WEBSITE_SUPABASE_URL;
const WEBSITE_KEY = env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY;
const WEBSITE_TABLE = env.WEBSITE_EVENTS_TABLE || 'events';
const WEBSITE_JOBS_TABLE = env.WEBSITE_JOBS_TABLE || 'jobs';
const JOBS_SYNC_ENABLED = env.WEBSITE_JOBS_SYNC_ENABLED !== false;
const WEBSITE_SCHOLARSHIPS_TABLE = env.WEBSITE_SCHOLARSHIPS_TABLE || 'scholarships';
const SCHOLARSHIPS_SYNC_ENABLED = env.WEBSITE_SCHOLARSHIPS_SYNC_ENABLED !== false;
const DRY_RUN = env.WEBSITE_SYNC_DRY_RUN === true;
const BATCH_SIZE = Math.max(1, env.WEBSITE_SYNC_BATCH_SIZE || 50);
const BATCH_DELAY_MS = Math.max(0, env.WEBSITE_SYNC_BATCH_DELAY_MS || 200);
const REVALIDATE_URL = env.WEBSITE_REVALIDATE_URL;
const REVALIDATE_SECRET = env.WEBSITE_REVALIDATE_SECRET;

const BOT_USER_ID = 'pulchowk-events';

let websiteSupabase = null;
if (WEBSITE_URL && WEBSITE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    websiteSupabase = createClient(WEBSITE_URL, WEBSITE_KEY, { auth: { persistSession: false } });
}

function isConfigured() { return Boolean(websiteSupabase); }
function isEnabled() { return env.WEBSITE_SYNC_ENABLED !== false; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// Deterministic UUID from dedup key. Idempotent upserts via ON CONFLICT
// (id) — re-running sync on the same item updates the existing row.
function deterministicUUID(input) {
    const hash = crypto.createHash('sha1').update(input).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function matchesBlacklist(bot, text, organizer) {
    const blacklist = bot.cache.settings.blacklist || { keywords: [], organizers: [] };
    const haystack = (text || '').toLowerCase();
    for (const kw of (blacklist.keywords || [])) if (kw && haystack.includes(kw.toLowerCase())) return true;
    const org = (organizer || '').toLowerCase();
    for (const bo of (blacklist.organizers || [])) if (bo && org.includes(bo.toLowerCase())) return true;
    return false;
}

// ---------- Event gates + mapper ----------

function passesWebsiteGates(bot, event) {
    if (event.itemType) return false;   // exclude jobs and scholarships
    if (!bot.hasValidImage(event)) return false;
    if (bot.hasDataQualityWarnings(event)) return false;
    if (matchesBlacklist(bot, `${event.title || ''} ${event.description || ''}`, event.organizer)) return false;
    return true;
}

function getScholarshipWebsiteDedupKey(scholarship) {
    const url = scholarship.url || scholarship.registrationUrl || '';
    if (url) return `url:${url.trim().toLowerCase()}`;
    // Fallback for scholarships with no URL — should not happen in practice
    // but keeps upsert idempotent if it does. Same reasoning as jobs: the
    // URL is a stable identity; the parsed deadline can drift ("estimated-
    // year-only" is synthesized, and parseScholarshipDeadline can shift
    // year boundaries like the events path does).
    const title = (scholarship.title || '').trim().toLowerCase();
    const source = (scholarship.source || '').trim().toLowerCase();
    return `scholarship:${title}|${source}`;
}

function passesScholarshipGates(bot, scholarship) {
    if (scholarship.itemType !== 'scholarship') return false;
    // No hasValidImage gate — scholarships are image-optional by product
    // decision, and the bot's own postEventToCategory treats them the same
    // way. Adding a gate here would silently drop legitimate records.
    if (bot.hasDataQualityWarnings(scholarship)) return false;
    if (matchesBlacklist(
        bot,
        `${scholarship.title || ''} ${scholarship.description || ''}`,
        scholarship.provider || scholarship.organizer
    )) return false;
    // Expired: bot.isEventPast handles the scholarship-specific rule
    // internally — rolling/unknown/no-parsed-deadline items are never past,
    // only parsed deadlines in the past trigger exclusion.
    if (bot.isEventPast(scholarship)) return false;
    return true;
}

function computeEligibleScholarships(bot) {
    const pending = (bot.cache.pendingEvents || []).filter((e) => passesScholarshipGates(bot, e));
    const posted = (bot.cache.postedEvents || []).filter((e) => passesScholarshipGates(bot, e));
    const byKey = new Map();
    for (const s of pending) byKey.set(getScholarshipWebsiteDedupKey(s), { scholarship: s, bucket: 'pending' });
    for (const s of posted) byKey.set(getScholarshipWebsiteDedupKey(s), { scholarship: s, bucket: 'posted' });
    return Array.from(byKey.values());
}

function scholarshipToWebsiteRow(bot, scholarship) {
    const applyUrl = scholarship.registrationUrl || scholarship.url;
    if (!applyUrl) return null;
    const dedupKey = getScholarshipWebsiteDedupKey(scholarship);
    const firstSeen = scholarship.firstSeenAt
        ? new Date(scholarship.firstSeenAt)
        : (scholarship.scrapedAt ? new Date(scholarship.scrapedAt) : new Date());
    // Re-derive deadlineDisplay at row-build time. Cache items from before
    // the deadlineText.js / shape.js fix have the chrome string ("♡ Save &
    // track") baked into scholarship.deadlineDisplay. Reading it directly
    // would sync the stale value; calling normalizeScholarshipToEventShape()
    // here recomputes it from deadlineRaw/deadlineParsed and drops the chrome.
    const shape = normalizeScholarshipToEventShape(scholarship);
    return {
        id: deterministicUUID(dedupKey),
        bot_dedup_key: dedupKey,
        origin: `scraper:${scholarship.source || 'unknown'}`,
        title: scholarship.title || 'Untitled Scholarship',
        description: scholarship.description || null,
        provider: scholarship.provider || scholarship.organizer || null,
        deadline_parsed: scholarship.deadlineParsed || null,
        deadline_status: scholarship.deadlineStatus || null,
        deadline_display: shape.deadlineDisplay || null,
        deadline_raw: scholarship.deadlineRaw || null,
        funding_type: scholarship.fundingType || null,
        funding_amount: scholarship.fundingAmount || null,
        degree_level: scholarship.degreeLevel || null,
        field_of_study: scholarship.fieldOfStudy || null,
        image_url: scholarship.image || null,
        tags: Array.isArray(scholarship.tags) ? scholarship.tags.slice(0, 30) : [],
        apply_url: applyUrl,
        source_url: scholarship.url || null,
        source: scholarship.source || null,
        created_by: BOT_USER_ID,
        verified: true,
        first_seen_at: firstSeen.toISOString(),
        posted_at: firstSeen.toISOString(),
        updated_at: new Date().toISOString()
    };
}

function computeEligible(bot) {
    const pending = (bot.cache.pendingEvents || []).filter((e) => passesWebsiteGates(bot, e));
    const posted = (bot.cache.postedEvents || []).filter((e) => passesWebsiteGates(bot, e));
    const byKey = new Map();
    for (const e of pending) byKey.set(bot.getEventDedupKey(e), { event: e, bucket: 'pending' });
    for (const e of posted) byKey.set(bot.getEventDedupKey(e), { event: e, bucket: 'posted' });
    return Array.from(byKey.values());
}

function mapCategory(botCategory) {
    const directMap = { software: 'software', gaming: 'gaming', hardware: 'hardware', music: 'music', sports: 'sports' };
    return directMap[botCategory] || 'extra';
}

function eventToWebsiteRow(bot, event) {
    const parsed = bot.parseEventDate(event);
    if (!parsed) return null;
    const formLink = event.registrationUrl || event.url;
    if (!formLink) return null;
    const dedupKey = bot.getEventDedupKey(event);
    return {
        id: deterministicUUID(dedupKey),
        bot_dedup_key: dedupKey,
        origin: `scraper:${event.source || 'unknown'}`,
        title: event.title,
        description: event.description || '',
        event_date: parsed.toISOString(),
        form_link: formLink,
        image_url: event.image || null,
        category: mapCategory(bot.determineCategory(event)),
        created_by: BOT_USER_ID,
        verified: true,
        source_url: event.url || null,
        location: event.location || null,
        price: event.price || null,
        organizer: event.organizer || null,
        attendance_mode: event.attendanceMode || null
    };
}

// ---------- Job gates + mapper ----------
// Jobs get a URL-based dedup key, NOT the bot's title+date key: some
// sources (MeroJob) synthesize applicationEndsRaw from a relative deadline
// ("2 weeks from now") which shifts by ~1 day on each re-scrape. Using
// title+date would create a new row on every scrape. The listing URL is
// stable, so it's the correct anchor for website identity.

function getJobWebsiteDedupKey(job) {
    const url = job.url || job.registrationUrl || '';
    if (url) return `url:${url.trim().toLowerCase()}`;
    const title = (job.title || '').trim().toLowerCase();
    const company = (job.company || '').trim().toLowerCase();
    return `job:${title}|${company}`;
}

function jobEndsAt(job) {
    if (!job.applicationEndsDate) return null;
    const d = new Date(job.applicationEndsDate);
    return isNaN(d.getTime()) ? null : d;
}

function passesJobGates(bot, job) {
    if (job.itemType !== 'job') return false;
    if (!bot.hasValidImage(job)) return false;
    if (bot.hasDataQualityWarnings(job)) return false;
    if (matchesBlacklist(bot, `${job.title || ''} ${job.description || ''} ${job.company || ''}`, job.company || job.organizer)) return false;
    const endsAt = jobEndsAt(job);
    if (endsAt && endsAt.getTime() < Date.now()) return false;   // expired
    // Deliberately NOT applying isEventTooSoon — see file header.
    return true;
}

function computeEligibleJobs(bot) {
    const pending = (bot.cache.pendingEvents || []).filter((e) => passesJobGates(bot, e));
    const posted = (bot.cache.postedEvents || []).filter((e) => passesJobGates(bot, e));
    const byKey = new Map();
    for (const j of pending) byKey.set(getJobWebsiteDedupKey(j), { job: j, bucket: 'pending' });
    for (const j of posted) byKey.set(getJobWebsiteDedupKey(j), { job: j, bucket: 'posted' });
    return Array.from(byKey.values());
}

function normalizeEmploymentType(raw) {
    if (!raw) return null;
    const s = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (s.includes('full')) return 'Full-time';
    if (s.includes('part')) return 'Part-time';
    if (s.includes('intern')) return 'Internship';
    if (s.includes('contract')) return 'Contract';
    if (s.includes('freelance')) return 'Freelance';
    if (s.includes('temporary') || s.includes('temp')) return 'Temporary';
    return raw;
}

function normalizeAttendanceMode(raw) {
    if (!raw) return null;
    const s = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (s.includes('remote')) return 'Remote';
    if (s.includes('hybrid')) return 'Hybrid';
    if (s.includes('onsite') || s.includes('office') || s.includes('inperson')) return 'Onsite';
    return raw;
}

function normalizeOpenings(raw) {
    if (raw == null) return null;
    const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function buildJobDescription(job) {
    const parts = [];
    if (job.description) parts.push(job.description.trim());
    if (job.responsibilities) parts.push(`Responsibilities:\n${job.responsibilities.trim()}`);
    if (job.requirements) parts.push(`Requirements:\n${job.requirements.trim()}`);
    return parts.join('\n\n').slice(0, 8000);
}

function jobToWebsiteRow(bot, job) {
    const url = job.url || job.registrationUrl;
    if (!url) return null;
    const company = job.company;
    if (!company) return null;
    const dedupKey = getJobWebsiteDedupKey(job);
    const endsAt = jobEndsAt(job);
    const firstSeen = job.firstSeenAt
        ? new Date(job.firstSeenAt)
        : (job.scrapedAt ? new Date(job.scrapedAt) : new Date());
    return {
        id: deterministicUUID(dedupKey),
        bot_dedup_key: dedupKey,
        origin: `scraper:${job.source || 'unknown'}`,
        title: job.title || 'Untitled Job',
        company,
        description: buildJobDescription(job),
        location: job.location || null,
        salary: job.salary || null,
        experience: job.experience || null,
        level: job.level || null,
        openings: normalizeOpenings(job.openings),
        employment_type: normalizeEmploymentType(job.employmentType),
        attendance_mode: normalizeAttendanceMode(job.attendanceMode),
        skills: Array.isArray(job.skills) ? job.skills.slice(0, 30) : [],
        url,
        image_url: job.companyLogoUrl || job.image || null,
        application_ends_at: endsAt ? endsAt.toISOString() : null,
        application_ends_raw: job.applicationEndsRaw || null,
        posted_at: firstSeen.toISOString(),
        updated_at: new Date().toISOString(),
        verified: true
    };
}

// ---------- User-collision (events only) ----------
async function fetchUserEventsLookup() {
    try {
        const { data, error } = await websiteSupabase
            .from(WEBSITE_TABLE)
            .select('id, title, event_date')
            .eq('origin', 'user');
        if (error) throw error;
        const byDate = new Map();
        for (const ue of data || []) {
            const d = (ue.event_date || '').split('T')[0];
            if (!d) continue;
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d).push((ue.title || '').toLowerCase());
        }
        return byDate;
    } catch (err) {
        auditLog('website_sync', `User-collision lookup failed: ${err.message}`, { error: err.message }, 'warn');
        return new Map();
    }
}

// Words that appear in too many titles to be a meaningful collision signal.
// A user-submitted event on the same date as a bot event should NOT suppress
// the bot event just because both titles contain "Nepal", "The", "New", etc.
// Keep this list small and focused on words that carry no distinguishing
// information on their own.
const COLLISION_STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by',
    'with', 'from', 'live', 'annual', 'event', 'events', 'nepal', 'nepali',
    'kathmandu', 'national', 'international', 'new', 'big', 'best', 'free'
]);

// Extract substantive words from a title, lowercased and stripped of
// punctuation. "Substantive" = length >= 4 chars and not in the stopword list.
function substantiveWords(title) {
    if (!title) return [];
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !COLLISION_STOPWORDS.has(w));
}

// True when a user-submitted event on the same date as a bot event shares at
// least one substantive word with it. Two events sharing only stopwords or
// only a short common word ("AI", "Art") are NOT considered collisions.
//
// Previous implementation used substring matching on the bot's first word,
// which over-triggered on:
//   - common first words ("Nepal", "The") suppressing unrelated bot events
//   - substring matches ("AI" matching inside "AIDS", "Cat" inside "Catalogue")
// The current implementation requires a full-word match of a word >= 4 chars
// that isn't a stopword.
function isUserCollision(userEventsByDate, row) {
    const dateOnly = row.event_date.split('T')[0];
    const candidateTitles = userEventsByDate.get(dateOnly);
    if (!candidateTitles || candidateTitles.length === 0) return false;

    const botWords = substantiveWords(row.title);
    if (botWords.length === 0) return false;

    for (const ut of candidateTitles) {
        const userWords = new Set(substantiveWords(ut));
        for (const w of botWords) {
            if (userWords.has(w)) return true;
        }
    }
    return false;
}

// ---------- Revalidation webhook ----------
async function triggerRevalidation(tags) {
    if (!REVALIDATE_URL || !REVALIDATE_SECRET) return;
    try {
        const res = await fetch(REVALIDATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Revalidate-Secret': REVALIDATE_SECRET },
            body: JSON.stringify({ tags })
        });
        if (!res.ok) console.warn(`⚠️ [websiteSync] Revalidation returned ${res.status}`);
        else console.log(`🔄 [websiteSync] Revalidated tags: ${tags.join(', ')}`);
    } catch (err) {
        console.warn(`⚠️ [websiteSync] Revalidation failed: ${err.message}`);
    }
}

// ---------- Generic per-table sync with guards ----------
async function syncOneTable(bot, { tableName, rows, label, emit, log, startMs, skippedInfo = {} }) {
    const tableStartMs = Date.now();
    const batchStats = { inserted: 0, failed: 0, errors: [] };
    const batches = chunkArray(rows, BATCH_SIZE);
    log(`[${label}] Upserting ${rows.length} row(s) in ${batches.length} batch(es)...`);

    if (!DRY_RUN) {
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
                const { error } = await websiteSupabase.from(tableName).upsert(batch, { onConflict: 'id' });
                if (error) throw error;
                batchStats.inserted += batch.length;
            } catch (err) {
                batchStats.failed += batch.length;
                batchStats.errors.push(err.message);
                log(`[${label}] ❌ Batch ${i + 1}/${batches.length} FAILED: ${err.message}`);
                auditLog('website_sync', `[${label}] Batch ${i + 1} failed (${batch.length} rows): ${err.message}`, {
                    table: tableName, error: err.message, batchIndex: i, batchSize: batch.length
                }, 'error');
            }
            const elapsed = Date.now() - startMs;
            const pct = Math.round(((i + 1) / batches.length) * 100);
            log(`[${label}] Batch ${i + 1}/${batches.length} — ${batchStats.inserted}/${rows.length} upserted, ${batchStats.failed} failed — ${elapsed}ms (${pct}%)`);
            emit({ phase: 'upserting', table: label, batchIndex: i + 1, totalBatches: batches.length,
                   processed: batchStats.inserted + batchStats.failed, total: rows.length, failed: batchStats.failed, elapsedMs: elapsed });
            if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
        }
    } else {
        log(`[${label}] [DRY RUN] Would upsert ${rows.length} row(s)`);
        batchStats.inserted = rows.length;
        emit({ phase: 'upserting_dry', table: label, total: rows.length });
    }

    // Prune orphans, with two safety guards.
    const currentKeys = new Set(rows.map((r) => r.bot_dedup_key));
    const pruneResult = { deleted: 0, aborted: false, reason: null };
    try {
        log(`[${label}] Checking for orphan rows to prune...`);
        emit({ phase: 'pruning_start', table: label });
        const { data: existing, error: fetchErr } = await websiteSupabase
            .from(tableName)
            .select('id, bot_dedup_key')
            .like('origin', 'scraper:%');
        if (fetchErr) throw fetchErr;

        const orphans = (existing || []).filter((r) => r.bot_dedup_key && !currentKeys.has(r.bot_dedup_key));
        log(`[${label}] ${orphans.length} orphan(s) out of ${(existing || []).length} existing bot row(s)`);

        if (rows.length === 0 && (existing || []).length > 0) {
            pruneResult.aborted = true;
            pruneResult.reason = 'empty_eligible_set';
            log(`[${label}] 🚨 Prune ABORTED: eligible=0 but table has ${existing.length} bot row(s)`);
        } else if (orphans.length > (existing || []).length * 0.5 && (existing || []).length > 10) {
            pruneResult.aborted = true;
            pruneResult.reason = 'delete_threshold_exceeded';
            log(`[${label}] 🚨 Prune ABORTED: would delete ${orphans.length}/${existing.length} (>50%)`);
        } else if (orphans.length > 0) {
            if (DRY_RUN) {
                pruneResult.deleted = orphans.length;
                log(`[${label}] [DRY RUN] Would delete ${orphans.length} orphan(s)`);
            } else {
                for (let i = 0; i < orphans.length; i++) {
                    const { error } = await websiteSupabase.from(tableName).delete().eq('id', orphans[i].id);
                    if (!error) pruneResult.deleted++;
                    if ((i + 1) % 10 === 0) {
                        emit({ phase: 'pruning', table: label, processed: i + 1, total: orphans.length, deleted: pruneResult.deleted });
                    }
                    await sleep(50);
                }
                log(`[${label}] Pruned ${pruneResult.deleted}/${orphans.length} orphan(s)`);
            }
        }
    } catch (err) {
        log(`[${label}] ❌ Prune failed: ${err.message}`);
        pruneResult.reason = err.message;
    }

    return {
        table: tableName,
        label,
        eligibleCount: rows.length + (skippedInfo.total || 0),
        syncedCount: batchStats.inserted,
        failedCount: batchStats.failed,
        prunedCount: pruneResult.deleted,
        pruneAborted: pruneResult.aborted,
        pruneAbortReason: pruneResult.reason,
        errors: batchStats.errors,
        skipped: skippedInfo,
        durationMs: Date.now() - tableStartMs
    };
}

// ---------- Main entry ----------
async function syncWebsite(bot, options = {}) {
    const { onProgress } = options;
    const emit = (p) => { if (onProgress) { try { onProgress(p); } catch (_) {} } };
    const log = (msg) => console.log(`🌐 [websiteSync] ${msg}`);

    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };

    const startMs = Date.now();
    log(`Sync starting (mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'})`);

    // Events
    log('Computing eligible events...');
    emit({ phase: 'computing', table: 'events' });
    const eligible = computeEligible(bot);
    const rowsWithNull = eligible.map(({ event }) => eventToWebsiteRow(bot, event));
    const eventRows = rowsWithNull.filter(Boolean);
    const skippedNoDate = eligible.length - eventRows.length;
    log(`Events: ${eligible.length} eligible, ${eventRows.length} mappable, ${skippedNoDate} skipped (no date/URL)`);

    const userEventsByDate = await fetchUserEventsLookup();
    const finalEventRows = eventRows.filter((row) => !isUserCollision(userEventsByDate, row));
    const skippedCollisions = eventRows.length - finalEventRows.length;
    if (skippedCollisions > 0) log(`Events: ${skippedCollisions} skipped (user-collision)`);

    const eventResult = await syncOneTable(bot, {
        tableName: WEBSITE_TABLE, rows: finalEventRows, label: 'events', emit, log, startMs,
        skippedInfo: { noDate: skippedNoDate, collision: skippedCollisions }
    });

    // Jobs
    let jobResult = null;
    if (JOBS_SYNC_ENABLED) {
        log('Computing eligible jobs...');
        emit({ phase: 'computing', table: 'jobs' });
        const jobEligible = computeEligibleJobs(bot);
        const jobRowsRaw = jobEligible.map(({ job }) => jobToWebsiteRow(bot, job));
        const jobRows = jobRowsRaw.filter(Boolean);
        const jobSkippedNoUrl = jobEligible.length - jobRows.length;
        log(`Jobs: ${jobEligible.length} eligible, ${jobRows.length} mappable, ${jobSkippedNoUrl} skipped (no URL/company)`);
        jobResult = await syncOneTable(bot, {
            tableName: WEBSITE_JOBS_TABLE, rows: jobRows, label: 'jobs', emit, log, startMs,
            skippedInfo: { noUrl: jobSkippedNoUrl }
        });
    }

    // Scholarships
    let scholarshipResult = null;
    if (SCHOLARSHIPS_SYNC_ENABLED) {
        log('Computing eligible scholarships...');
        emit({ phase: 'computing', table: 'scholarships' });
        const scholarshipEligible = computeEligibleScholarships(bot);
        const scholarshipRowsRaw = scholarshipEligible.map(({ scholarship }) => scholarshipToWebsiteRow(bot, scholarship));
        const scholarshipRows = scholarshipRowsRaw.filter(Boolean);
        const scholarshipSkippedNoUrl = scholarshipEligible.length - scholarshipRows.length;
        log(`Scholarships: ${scholarshipEligible.length} eligible, ${scholarshipRows.length} mappable, ${scholarshipSkippedNoUrl} skipped (no URL)`);
        scholarshipResult = await syncOneTable(bot, {
            tableName: WEBSITE_SCHOLARSHIPS_TABLE, rows: scholarshipRows, label: 'scholarships', emit, log, startMs,
            skippedInfo: { noUrl: scholarshipSkippedNoUrl }
        });
    }

    // Summary
    const durationMs = Date.now() - startMs;
    const eventsSynced = eventResult.syncedCount;
    const eventsFailed = eventResult.failedCount;
    const eventsPruned = eventResult.prunedCount;
    const jobsSynced = jobResult ? jobResult.syncedCount : 0;
    const jobsFailed = jobResult ? jobResult.failedCount : 0;
    const jobsPruned = jobResult ? jobResult.prunedCount : 0;
    const scholarshipsSynced = scholarshipResult ? scholarshipResult.syncedCount : 0;
    const scholarshipsFailed = scholarshipResult ? scholarshipResult.failedCount : 0;
    const scholarshipsPruned = scholarshipResult ? scholarshipResult.prunedCount : 0;

    const summary = {
        ok: eventsFailed === 0 && jobsFailed === 0 && scholarshipsFailed === 0,
        dryRun: DRY_RUN,
        durationMs,
        syncedCount: eventsSynced + jobsSynced + scholarshipsSynced,
        failedCount: eventsFailed + jobsFailed + scholarshipsFailed,
        prunedCount: eventsPruned + jobsPruned + scholarshipsPruned,
        events: eventResult,
        jobs: jobResult,
        scholarships: scholarshipResult,
        errors: [...eventResult.errors, ...((jobResult && jobResult.errors) || []), ...((scholarshipResult && scholarshipResult.errors) || [])]
    };

    log(`${DRY_RUN ? '[DRY RUN] ' : ''}Complete — events: ${eventsSynced} synced/${eventsPruned} pruned/${eventsFailed} failed` +
        (jobResult ? ` • jobs: ${jobsSynced}/${jobsPruned}/${jobsFailed}` : '') +
        (scholarshipResult ? ` • scholarships: ${scholarshipsSynced}/${scholarshipsPruned}/${scholarshipsFailed}` : '') +
        ` — ${durationMs}ms`);

    auditLog('website_sync',
        DRY_RUN
            ? `[DRY RUN] Would sync ${eventsSynced} events + ${jobsSynced} jobs + ${scholarshipsSynced} scholarships`
            : `Synced ${eventsSynced} events + ${jobsSynced} jobs + ${scholarshipsSynced} scholarships (${eventsPruned + jobsPruned + scholarshipsPruned} pruned, ${eventsFailed + jobsFailed + scholarshipsFailed} failed)`,
        summary, summary.ok ? 'info' : 'warn');

    if (!DRY_RUN && bot.sendLogMessage) {
        const parts = [
            `🌐 Website sync: ${eventsSynced} events + ${jobsSynced} jobs + ${scholarshipsSynced} scholarships synced`,
            (eventsPruned + jobsPruned + scholarshipsPruned) > 0 ? `${eventsPruned + jobsPruned + scholarshipsPruned} pruned` : null,
            (eventsFailed + jobsFailed + scholarshipsFailed) > 0 ? `⚠️ ${eventsFailed + jobsFailed + scholarshipsFailed} failed` : null,
            eventResult.pruneAborted ? '🚨 events prune aborted' : null,
            jobResult && jobResult.pruneAborted ? '🚨 jobs prune aborted' : null,
            scholarshipResult && scholarshipResult.pruneAborted ? '🚨 scholarships prune aborted' : null
        ].filter(Boolean);
        bot.sendLogMessage(parts.join(' — ')).catch(() => {});
    }

    if (!DRY_RUN && (eventsSynced > 0 || eventsPruned > 0 || jobsSynced > 0 || jobsPruned > 0 || scholarshipsSynced > 0 || scholarshipsPruned > 0)) {
        const tags = [];
        if (eventsSynced > 0 || eventsPruned > 0) tags.push('events', 'sidebar');
        if (jobsSynced > 0 || jobsPruned > 0) tags.push('jobs');
        if (scholarshipsSynced > 0 || scholarshipsPruned > 0) tags.push('scholarships');
        if (tags.length > 0) await triggerRevalidation(tags);
    }

    emit({ phase: 'done', result: summary });
    return summary;
}

async function checkWebsiteSyncHealth(bot) {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };

    const eligible = computeEligible(bot);
    const expectedKeys = new Set(eligible.map(({ event }) => bot.getEventDedupKey(event)));
    const { data: existing } = await websiteSupabase
        .from(WEBSITE_TABLE).select('bot_dedup_key').like('origin', 'scraper:%');
    const existingKeys = new Set((existing || []).map((r) => r.bot_dedup_key).filter(Boolean));
    const missing = [...expectedKeys].filter((k) => !existingKeys.has(k));
    const orphans = [...existingKeys].filter((k) => !expectedKeys.has(k));

    let jobsHealth = null;
    if (JOBS_SYNC_ENABLED) {
        const eligibleJobs = computeEligibleJobs(bot);
        const expectedJobKeys = new Set(eligibleJobs.map(({ job }) => getJobWebsiteDedupKey(job)));
        const { data: existingJobs } = await websiteSupabase
            .from(WEBSITE_JOBS_TABLE).select('bot_dedup_key').like('origin', 'scraper:%');
        const existingJobKeys = new Set((existingJobs || []).map((r) => r.bot_dedup_key).filter(Boolean));
        jobsHealth = {
            expected: expectedJobKeys.size,
            existing: existingJobKeys.size,
            missing: [...expectedJobKeys].filter((k) => !existingJobKeys.has(k)).length,
            orphan: [...existingJobKeys].filter((k) => !expectedJobKeys.has(k)).length
        };
    }

    let scholarshipsHealth = null;
    if (SCHOLARSHIPS_SYNC_ENABLED) {
        const eligibleScholarships = computeEligibleScholarships(bot);
        const expectedScholKeys = new Set(eligibleScholarships.map(({ scholarship }) => getScholarshipWebsiteDedupKey(scholarship)));
        const { data: existingSchol } = await websiteSupabase
            .from(WEBSITE_SCHOLARSHIPS_TABLE).select('bot_dedup_key').like('origin', 'scraper:%');
        const existingScholKeys = new Set((existingSchol || []).map((r) => r.bot_dedup_key).filter(Boolean));
        scholarshipsHealth = {
            expected: expectedScholKeys.size,
            existing: existingScholKeys.size,
            missing: [...expectedScholKeys].filter((k) => !existingScholKeys.has(k)).length,
            orphan: [...existingScholKeys].filter((k) => !expectedScholKeys.has(k)).length
        };
    }

    return {
        ok: missing.length === 0 && orphans.length === 0
            && (!jobsHealth || (jobsHealth.missing === 0 && jobsHealth.orphan === 0))
            && (!scholarshipsHealth || (scholarshipsHealth.missing === 0 && scholarshipsHealth.orphan === 0)),
        expectedCount: expectedKeys.size,
        existingCount: existingKeys.size,
        missingCount: missing.length,
        orphanCount: orphans.length,
        missing, orphans, jobs: jobsHealth, scholarships: scholarshipsHealth
    };
}

// Debounced scheduler — enqueue a sync N ms from now, replacing any prior
// pending schedule. Used by attachHooks to react to cache mutations
// without hammering the website DB on every mutation.
let pendingSyncTimer = null;
function scheduleSync(bot, delayMs = 30000) {
    if (!isEnabled() || !isConfigured()) return;
    if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
    pendingSyncTimer = setTimeout(() => {
        pendingSyncTimer = null;
        syncWebsite(bot).catch((err) => console.error('❌ [websiteSync] scheduled sync failed:', err));
    }, delayMs);
    if (pendingSyncTimer.unref) pendingSyncTimer.unref();
}

module.exports = {
    WEBSITE_TABLE,
    WEBSITE_JOBS_TABLE,
    WEBSITE_SCHOLARSHIPS_TABLE,
    JOBS_SYNC_ENABLED,
    SCHOLARSHIPS_SYNC_ENABLED,
    DRY_RUN,
    BATCH_SIZE,
    isConfigured,
    isEnabled,
    syncWebsite,
    checkWebsiteSyncHealth,
    computeEligible,
    computeEligibleJobs,
    computeEligibleScholarships,
    passesWebsiteGates,
    passesJobGates,
    passesScholarshipGates,
    eventToWebsiteRow,
    jobToWebsiteRow,
    scholarshipToWebsiteRow,
    getJobWebsiteDedupKey,
    getScholarshipWebsiteDedupKey,
    triggerRevalidation,
    scheduleSync
};
