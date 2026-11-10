// src/integrations/supabase.js
// Bot archival Supabase sync. Service-role client (full records, all item
// types), writes to EVENTS_TABLE (events + jobs share it via a `type`
// column) and SCHOLARSHIPS_TABLE (separate shape).
//
// IMPORTANT SAFETY RULE: only cache.postedEvents is ever uploaded — items
// that were genuinely posted to a LIVE channel. Items that only got a TEST
// post, or are still pending, are never touched by this module.
//
// Sync happens in batches of UPSERT_BATCH_SIZE rows. A failure in one
// batch doesn't sink the others — every other batch still uploads and gets
// marked synced, and only the failed batch's items remain unsynced for the
// next /supabase sync-now or auto-sync tick to retry.

const { createClient } = require('@supabase/supabase-js');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { auditLog } = require('../core/auditLogger');
const env = require('../config/env');

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const EVENTS_TABLE = env.SUPABASE_EVENTS_TABLE || 'events';
const SCHOLARSHIPS_TABLE = env.SUPABASE_SCHOLARSHIPS_TABLE || 'scholarships';
const DEFAULT_AUTOSYNC_INTERVAL_MINUTES = env.SUPABASE_AUTOSYNC_INTERVAL_MINUTES || 60;
const UPSERT_BATCH_SIZE = Math.max(1, env.SUPABASE_UPSERT_BATCH_SIZE || 500);

const SYNCED_KEYS_CAP = 5000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
} else {
    console.warn('⚠️ [supabase.js] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — Supabase archival sync disabled.');
}

function isConfigured() { return Boolean(supabase); }

function ensureSyncState(bot) {
    bot.cache.settings.supabaseSync = bot.cache.settings.supabaseSync || {};
    const s = bot.cache.settings.supabaseSync;
    s.autoSync = s.autoSync || { active: false, intervalMinutes: DEFAULT_AUTOSYNC_INTERVAL_MINUTES };
    s.syncedEventKeys = s.syncedEventKeys || [];
    s.lastSyncAt = s.lastSyncAt || null;
    s.lastSyncResult = s.lastSyncResult || null;
    s.nextSyncAt = s.nextSyncAt || null;
    return s;
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function toIsoOrNull(bot, item) {
    try {
        const parsed = bot.parseEventDate(item);
        return parsed ? parsed.toISOString() : null;
    } catch (e) {
        return null;
    }
}

// Same as bot.getEventDedupKey(), but jobs also fold in company (falling
// back to organizer) so two different companies' postings with the same
// title and same apply-by date don't collapse onto one row.
function getSupabaseRowKey(bot, item) {
    const baseKey = bot.getEventDedupKey(item);
    const isJob = item.itemType === 'job';
    const disambiguatorRaw = isJob ? (item.company || item.organizer || '') : (item.organizer || '');
    const disambiguator = bot.normalizeEventName(disambiguatorRaw);
    return disambiguator ? `${baseKey}|${disambiguator}` : baseKey;
}

function eventLikeToRow(bot, item) {
    const isJob = item.itemType === 'job';
    return {
        id: getSupabaseRowKey(bot, item),
        title: item.title || null,
        description: item.description || null,
        image: isJob ? (item.companyLogoUrl || item.image || null) : (item.image || null),
        location: item.location || null,
        date: isJob ? (item.applicationEndsRaw || null) : (item.date || null),
        price: isJob ? (item.salary || null) : (item.price || null),
        status: null,
        url: item.url || null,
        registration_url: item.registrationUrl || item.url || null,
        organizer: isJob ? (item.company || null) : (item.organizer || null),
        source: item.source || null,
        attendance_mode: item.attendanceMode || null,
        featured: Boolean(item.featured),
        first_seen_at: item.firstSeenAt ? Number(item.firstSeenAt) : null,
        company: isJob ? (item.company || null) : null,
        employment_type: isJob ? (item.employmentType || null) : null,
        salary: isJob ? (item.salary || null) : null,
        experience: isJob ? (item.experience || null) : null,
        level: isJob ? (item.level || null) : null,
        openings: isJob ? (item.openings || null) : null,
        application_ends_raw: isJob ? (item.applicationEndsRaw || null) : null,
        skills: Array.isArray(isJob ? item.skills : item.tags) ? (isJob ? item.skills : item.tags) : [],
        posted_at: Date.now(),
        type: isJob ? 'job' : 'event'
    };
}

function scholarshipToRow(bot, item) {
    return {
        id: getSupabaseRowKey(bot, item),
        title: item.title || null,
        description: item.description || null,
        provider: item.organizer || null,
        deadline_raw: item.deadlineRaw || null,
        deadline_parsed: item.deadlineParsed || null,
        deadline_status: item.deadlineStatus || null,
        deadline_display: item.deadlineDisplay || null,
        funding_type: item.fundingType || null,
        funding_amount: item.fundingAmount || null,
        degree_level: item.degreeLevel || null,
        field_of_study: item.fieldOfStudy || null,
        image: item.image || null,
        tags: Array.isArray(item.tags) ? item.tags : [],
        url: item.url || null,
        registration_url: item.registrationUrl || item.url || null,
        source: item.source || null,
        first_seen_at: item.firstSeenAt ? Number(item.firstSeenAt) : null,
        posted_at: Date.now(),
        type: 'scholarship'
    };
}

async function uploadItemsToTable(items, table, rowMapper, bot) {
    const byKey = new Map();
    for (const item of items) {
        const key = getSupabaseRowKey(bot, item);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(item);
    }
    const dedupedKeys = Array.from(byKey.keys());
    const rows = dedupedKeys.map((key) => {
        const group = byKey.get(key);
        return rowMapper(bot, group[group.length - 1]);
    });
    const duplicatesCollapsed = items.length - dedupedKeys.length;

    const rowChunks = chunkArray(rows, UPSERT_BATCH_SIZE);
    const keyChunks = chunkArray(dedupedKeys, UPSERT_BATCH_SIZE);

    let uploaded = 0;
    const errors = [];
    const syncedKeys = [];
    const uploadedRows = [];

    for (let i = 0; i < rowChunks.length; i++) {
        try {
            const { error } = await supabase.from(table).upsert(rowChunks[i], { onConflict: 'id' });
            if (error) {
                errors.push(`${table} batch ${i + 1}/${rowChunks.length}: ${error.message}`);
                continue;
            }
            uploaded += rowChunks[i].length;
            uploadedRows.push(...rowChunks[i]);
            syncedKeys.push(...keyChunks[i]);
        } catch (err) {
            errors.push(`${table} batch ${i + 1}/${rowChunks.length} threw: ${err.message || String(err)}`);
        }
    }

    if (duplicatesCollapsed > 0) {
        auditLog('supabase_sync', `Supabase sync (${table}) collapsed ${duplicatesCollapsed} duplicate-key item(s)`, {
            table, duplicatesCollapsed, uniqueKeys: dedupedKeys.length, totalCandidates: items.length
        }, 'warn');
    }

    return { uploaded, errors, syncedKeys, uploadedRows };
}

async function syncPostedEvents(bot, { force = false } = {}) {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };

    return bot.cacheMutex.runExclusive(async () => {
        const state = ensureSyncState(bot);
        const syncedSet = new Set(state.syncedEventKeys);

        const candidates = bot.cache.postedEvents.filter((e) => {
            const key = getSupabaseRowKey(bot, e);
            return force || !syncedSet.has(key);
        });

        if (candidates.length === 0) {
            state.lastSyncAt = Date.now();
            state.lastSyncResult = { uploaded: 0, events: 0, jobs: 0, scholarships: 0, errors: 0 };
            bot.saveCache();
            return { ok: true, uploaded: 0, events: 0, jobs: 0, scholarships: 0, errors: [] };
        }

        const scholarshipCandidates = candidates.filter((e) => e.itemType === 'scholarship');
        const eventJobCandidates = candidates.filter((e) => e.itemType !== 'scholarship');

        const eventsResult = eventJobCandidates.length > 0
            ? await uploadItemsToTable(eventJobCandidates, EVENTS_TABLE, eventLikeToRow, bot)
            : { uploaded: 0, errors: [], syncedKeys: [], uploadedRows: [] };

        const scholarshipsResult = scholarshipCandidates.length > 0
            ? await uploadItemsToTable(scholarshipCandidates, SCHOLARSHIPS_TABLE, scholarshipToRow, bot)
            : { uploaded: 0, errors: [], syncedKeys: [], uploadedRows: [] };

        for (const key of eventsResult.syncedKeys) syncedSet.add(key);
        for (const key of scholarshipsResult.syncedKeys) syncedSet.add(key);

        const eventsCount = eventsResult.uploadedRows.filter((r) => r.type === 'event').length;
        const jobsCount = eventsResult.uploadedRows.filter((r) => r.type === 'job').length;
        const scholarshipsCount = scholarshipsResult.uploadedRows.length;
        const uploaded = eventsResult.uploaded + scholarshipsResult.uploaded;
        const errors = [...eventsResult.errors, ...scholarshipsResult.errors];

        state.syncedEventKeys = Array.from(syncedSet).slice(-SYNCED_KEYS_CAP);
        state.lastSyncAt = Date.now();
        state.lastSyncResult = { uploaded, events: eventsCount, jobs: jobsCount, scholarships: scholarshipsCount, errors: errors.length };
        bot.saveCache();

        auditLog(
            'supabase_sync',
            errors.length > 0
                ? `Uploaded ${uploaded} row(s) with ${errors.length} batch error(s)`
                : `Uploaded ${uploaded} row(s) (${eventsCount}E/${jobsCount}J/${scholarshipsCount}S)`,
            { candidateCount: candidates.length, force, uploaded, events: eventsCount, jobs: jobsCount, scholarships: scholarshipsCount, errors },
            errors.length > 0 ? 'error' : 'info'
        );

        return { ok: errors.length === 0, uploaded, events: eventsCount, jobs: jobsCount, scholarships: scholarshipsCount, errors };
    });
}

async function republishAllPosted(bot) {
    return syncPostedEvents(bot, { force: true });
}

// ---------- auto-sync timer ----------
let autoSyncTimer = null;

function startAutoSync(bot, intervalMinutes = DEFAULT_AUTOSYNC_INTERVAL_MINUTES) {
    stopAutoSync(bot);
    const state = ensureSyncState(bot);
    state.autoSync = { active: true, intervalMinutes };
    bot.saveCache();

    const tick = async () => {
        if (!bot.cache.settings.supabaseSync.autoSync.active) return;
        try {
            const result = await syncPostedEvents(bot);
            if (result.ok && result.uploaded > 0) {
                await bot.sendLogMessage(`🗄️ Supabase auto-sync: uploaded ${result.uploaded} row(s) (${result.events}E/${result.jobs}J/${result.scholarships}S).`);
            } else if (!result.ok && result.reason !== 'not_configured') {
                await bot.sendLogMessage(`⚠️ Supabase auto-sync finished with errors: ${(result.errors || []).join('; ')}`);
            }
        } catch (error) {
            console.error('❌ Supabase auto-sync tick failed:', error);
            auditLog('supabase_sync', `Auto-sync tick threw: ${error.message}`, { errorMessage: error.message, errorStack: error.stack }, 'error');
        }
        if (bot.cache.settings.supabaseSync.autoSync.active) {
            const ms = bot.cache.settings.supabaseSync.autoSync.intervalMinutes * 60 * 1000;
            bot.cache.settings.supabaseSync.nextSyncAt = Date.now() + ms;
            bot.saveCache();
            autoSyncTimer = setTimeout(tick, ms);
            if (autoSyncTimer.unref) autoSyncTimer.unref();
        } else {
            bot.cache.settings.supabaseSync.nextSyncAt = null;
        }
    };

    tick();
}

function stopAutoSync(bot) {
    if (autoSyncTimer) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
    }
    const state = ensureSyncState(bot);
    state.autoSync.active = false;
    state.nextSyncAt = null;
    bot.saveCache();
}

// ---------- /supabase command ----------
const commands = [
    new SlashCommandBuilder()
        .setName('supabase')
        .setDescription('Manage syncing posted items to Supabase')
        .addSubcommand((sub) => sub.setName('sync-now').setDescription('Upload any posted items not yet synced'))
        .addSubcommand((sub) => sub.setName('republish-all').setDescription('Force re-upload everything in the posted-events cache'))
        .addSubcommand((sub) => sub.setName('autosync-start').setDescription('Start automatic syncing on an interval')
            .addIntegerOption((opt) => opt.setName('interval_minutes').setDescription('Minutes between syncs (default 60)').setRequired(false)))
        .addSubcommand((sub) => sub.setName('autosync-stop').setDescription('Stop automatic syncing'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Show Supabase sync status'))
];

async function handleCommand(interaction, bot) {
    const sub = interaction.options.getSubcommand();

    if (!isConfigured()) {
        return interaction.reply({
            content: '❌ Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env and restart.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (sub === 'sync-now') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await syncPostedEvents(bot);
        await interaction.editReply({
            content: r.ok
                ? `✅ Synced ${r.uploaded} row(s) (${r.events}E/${r.jobs}J/${r.scholarships}S).`
                : `⚠️ Sync finished with errors — ${r.uploaded} still uploaded: ${(r.errors || []).join('; ')}`
        });
    } else if (sub === 'republish-all') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await republishAllPosted(bot);
        await interaction.editReply({
            content: r.ok
                ? `✅ Republished ${r.uploaded} row(s) (${r.events}E/${r.jobs}J/${r.scholarships}S).`
                : `⚠️ Republish finished with errors — ${r.uploaded} still uploaded: ${(r.errors || []).join('; ')}`
        });
    } else if (sub === 'autosync-start') {
        const interval = interaction.options.getInteger('interval_minutes') || DEFAULT_AUTOSYNC_INTERVAL_MINUTES;
        if (interval <= 0) return interaction.reply({ content: '❌ Interval must be > 0.', flags: MessageFlags.Ephemeral });
        startAutoSync(bot, interval);
        await interaction.reply({ content: `✅ Supabase auto-sync started — every **${interval}m**.`, flags: MessageFlags.Ephemeral });
    } else if (sub === 'autosync-stop') {
        stopAutoSync(bot);
        await interaction.reply({ content: '🛑 Supabase auto-sync stopped.', flags: MessageFlags.Ephemeral });
    } else if (sub === 'status') {
        const state = ensureSyncState(bot);
        const embed = new EmbedBuilder()
            .setTitle('Supabase Sync Status')
            .addFields(
                { name: 'Configured', value: isConfigured() ? 'Yes' : 'No', inline: true },
                { name: 'Auto-sync', value: state.autoSync.active ? `🟢 every ${state.autoSync.intervalMinutes}m` : '⚪ off', inline: true },
                { name: 'Next auto-sync', value: state.autoSync.active && state.nextSyncAt ? `<t:${Math.floor(state.nextSyncAt / 1000)}:R>` : 'N/A', inline: true },
                { name: 'Synced keys tracked', value: `${state.syncedEventKeys.length} / ${SYNCED_KEYS_CAP}`, inline: true },
                { name: 'Batch size', value: String(UPSERT_BATCH_SIZE), inline: true },
                { name: 'Last sync', value: state.lastSyncAt ? `<t:${Math.floor(state.lastSyncAt / 1000)}:R>` : 'Never', inline: true },
                { name: 'Last result', value: state.lastSyncResult ? `${state.lastSyncResult.uploaded} uploaded (${state.lastSyncResult.events}E/${state.lastSyncResult.jobs}J/${state.lastSyncResult.scholarships}S), ${state.lastSyncResult.errors} err` : 'N/A', inline: true },
                { name: 'Posted events in cache', value: String(bot.cache.postedEvents.length), inline: true }
            )
            .setColor(0x3ECF8E);
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
}

function attach(bot) {
    ensureSyncState(bot);

    bot.client.once('ready', () => {
        const state = ensureSyncState(bot);
        if (state.autoSync.active) {
            console.log(`🗄️ [supabase] Resuming auto-sync (every ${state.autoSync.intervalMinutes}m) after restart.`);
            startAutoSync(bot, state.autoSync.intervalMinutes);
        }
        if (!isConfigured()) {
            console.warn('⚠️ [supabase] Ready, but Supabase env vars are missing.');
        }
    });

    // Register the /supabase command at ready. Uses REST POST like
    // extensions/index.js so it never touches the base commands.
    bot.client.once('ready', async () => {
        try {
            const { REST, Routes } = require('discord.js');
            const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
            for (const cmd of commands) {
                await rest.post(Routes.applicationCommands(bot.client.user.id), { body: cmd.toJSON() });
            }
            console.log(`✅ [supabase] Registered ${commands.length} command(s).`);
        } catch (error) {
            console.error('❌ [supabase] Failed to register command:', error);
        }
    });

    bot.supabaseSync = {
        isConfigured,
        syncNow: () => syncPostedEvents(bot),
        republishAll: () => republishAllPosted(bot),
        startAutoSync: (minutes) => startAutoSync(bot, minutes),
        stopAutoSync: () => stopAutoSync(bot)
    };
}

module.exports = {
    attach,
    commands,
    handleCommand,
    isConfigured,
    syncPostedEvents,
    republishAllPosted
};
