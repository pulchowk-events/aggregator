// src/integrations/websiteSync/commands.js
// The /website-sync command family:
//   now       — trigger a sync (events + jobs) with live progress
//   backfill  — same as now (alias retained for parity)
//   status    — current config + last sync info
//   health    — diff expected vs existing, report drift
//   prune     — force-delete orphans (bypasses the >50% guard)

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { auditLog } = require('../../core/auditLogger');
const engine = require('./engine');

let lastSyncAt = null;
let lastSyncResult = null;

function renderBar(pct, width = 20) {
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatProgressMessage(p) {
    const tablePrefix = p.table ? `[${p.table}] ` : '';
    if (p.phase === 'computing') return `🔄 ${tablePrefix}Computing eligible set...`;
    if (p.phase === 'upserting') {
        const pct = Math.round((p.processed / p.total) * 100);
        return `🔄 ${tablePrefix}Upserting\n\`${renderBar(pct)}\` **${pct}%**\n${p.processed}/${p.total} rows • batch ${p.batchIndex}/${p.totalBatches} • ${(p.elapsedMs / 1000).toFixed(1)}s` +
            (p.failed > 0 ? `\n⚠️ ${p.failed} failed so far` : '');
    }
    if (p.phase === 'upserting_dry') return `🔄 ${tablePrefix}[DRY RUN] Would upsert **${p.total}** row(s)`;
    if (p.phase === 'pruning_start') return `🔄 ${tablePrefix}Checking for orphans...`;
    if (p.phase === 'pruning') {
        const pct = Math.round((p.processed / p.total) * 100);
        return `🔄 ${tablePrefix}Pruning — ${p.processed}/${p.total} checked • ${p.deleted} deleted (${pct}%)`;
    }
    return '🔄 Working...';
}

function formatFinalResult(r) {
    const icon = r.ok ? '✅' : '⚠️';
    const mode = r.dryRun ? ' **[DRY RUN]**' : '';
    const ev = r.events;
    const jb = r.jobs;
    const evLine = `Events: ${ev.syncedCount} synced` +
        (ev.skipped && ev.skipped.noDate ? `, ${ev.skipped.noDate} no date` : '') +
        (ev.skipped && ev.skipped.collision ? `, ${ev.skipped.collision} collision` : '') +
        (ev.prunedCount > 0 ? `, ${ev.prunedCount} pruned` : '') +
        (ev.failedCount > 0 ? `, ⚠️ ${ev.failedCount} failed` : '') +
        (ev.pruneAborted ? ` 🚨 prune aborted (${ev.pruneAbortReason})` : '');
    const jbLine = jb
        ? `Jobs: ${jb.syncedCount} synced` +
            (jb.skipped && jb.skipped.noUrl ? `, ${jb.skipped.noUrl} no URL` : '') +
            (jb.prunedCount > 0 ? `, ${jb.prunedCount} pruned` : '') +
            (jb.failedCount > 0 ? `, ⚠️ ${jb.failedCount} failed` : '') +
            (jb.pruneAborted ? ` 🚨 prune aborted (${jb.pruneAbortReason})` : '')
        : 'Jobs: sync disabled';
    const sb = r.scholarships;
    const sbLine = sb
        ? `Scholarships: ${sb.syncedCount} synced` +
            (sb.skipped && sb.skipped.noUrl ? `, ${sb.skipped.noUrl} no URL` : '') +
            (sb.prunedCount > 0 ? `, ${sb.prunedCount} pruned` : '') +
            (sb.failedCount > 0 ? `, ⚠️ ${sb.failedCount} failed` : '') +
            (sb.pruneAborted ? ` 🚨 prune aborted (${sb.pruneAbortReason})` : '')
        : 'Scholarships: sync disabled';
    const errs = r.errors.length > 0 ? `\n\nErrors:\n${r.errors.slice(0, 5).join('\n')}` : '';
    return `${icon}${mode} Sync complete.\n${evLine}\n${jbLine}\n${sbLine}\nDuration: ${r.durationMs}ms${errs}`;
}

async function handleNow(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let lastEdit = 0;
    const progressCb = (p) => {
        const now = Date.now();
        if (now - lastEdit < 2000 && p.phase !== 'done') return;
        lastEdit = now;
        interaction.editReply({ content: formatProgressMessage(p) }).catch(() => {});
    };
    try {
        const result = await engine.syncWebsite(bot, { onProgress: progressCb });
        lastSyncAt = Date.now();
        lastSyncResult = result;
        await interaction.editReply({ content: formatFinalResult(result) }).catch(() => {});
    } catch (err) {
        await interaction.editReply({ content: `❌ Sync failed: ${err.message}` }).catch(() => {});
    }
}

async function handleStatus(bot, interaction) {
    const embed = new EmbedBuilder()
        .setTitle('Website Sync Status')
        .addFields(
            { name: 'Configured', value: engine.isConfigured() ? '✅ yes' : '❌ no', inline: true },
            { name: 'Enabled', value: engine.isEnabled() ? '✅ yes' : '⚪ no', inline: true },
            { name: 'Mode', value: engine.DRY_RUN ? '🧪 dry-run' : '🔴 live', inline: true },
            { name: 'Events table', value: `\`${engine.WEBSITE_TABLE}\``, inline: true },
            { name: 'Jobs table', value: engine.JOBS_SYNC_ENABLED ? `\`${engine.WEBSITE_JOBS_TABLE}\`` : '⚪ disabled', inline: true },
            { name: 'Scholarships table', value: engine.SCHOLARSHIPS_SYNC_ENABLED ? `\`${engine.WEBSITE_SCHOLARSHIPS_TABLE}\`` : '⚪ disabled', inline: true },
            { name: 'Batch size', value: String(engine.BATCH_SIZE), inline: true },
            { name: 'Last sync', value: lastSyncAt ? `<t:${Math.floor(lastSyncAt / 1000)}:R>` : 'never this session', inline: true },
            { name: 'Last result', value: lastSyncResult ? `${lastSyncResult.events.syncedCount}E + ${(lastSyncResult.jobs && lastSyncResult.jobs.syncedCount) || 0}J + ${(lastSyncResult.scholarships && lastSyncResult.scholarships.syncedCount) || 0}S synced` : 'N/A', inline: true }
        )
        .setColor(0x3ECF8E);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleHealth(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const health = await engine.checkWebsiteSyncHealth(bot);
        const lines = [
            `Events: expected ${health.expectedCount}, existing ${health.existingCount}, missing ${health.missingCount}, orphans ${health.orphanCount}`
        ];
        if (health.jobs) lines.push(`Jobs: expected ${health.jobs.expected}, existing ${health.jobs.existing}, missing ${health.jobs.missing}, orphans ${health.jobs.orphan}`);
        if (health.scholarships) lines.push(`Scholarships: expected ${health.scholarships.expected}, existing ${health.scholarships.existing}, missing ${health.scholarships.missing}, orphans ${health.scholarships.orphan}`);
        const okLine = health.ok ? '✅ In sync' : '⚠️ Drift detected';
        await interaction.editReply({
            content: `${okLine}\n\n${lines.join('\n')}` + (health.ok ? '' : '\n\nRun `/website-sync now` to reconcile.')
        });
    } catch (err) {
        await interaction.editReply({ content: `❌ Health check failed: ${err.message}` });
    }
}

async function handlePrune(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { createClient } = require('@supabase/supabase-js');
    const env = require('../../config/env');
    const websiteSupabase = createClient(env.WEBSITE_SUPABASE_URL, env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    let totalDeleted = 0;
    const tables = [{ name: engine.WEBSITE_TABLE, eligible: engine.computeEligible(bot), keyOf: (e) => bot.getEventDedupKey(e.event) }];
    if (engine.JOBS_SYNC_ENABLED) {
        tables.push({ name: engine.WEBSITE_JOBS_TABLE, eligible: engine.computeEligibleJobs(bot), keyOf: (j) => engine.getJobWebsiteDedupKey(j.job) });
    }
    for (const t of tables) {
        const currentKeys = new Set(t.eligible.map(t.keyOf));
        const { data: existing } = await websiteSupabase.from(t.name).select('id, bot_dedup_key').like('origin', 'scraper:%');
        const orphans = (existing || []).filter((r) => r.bot_dedup_key && !currentKeys.has(r.bot_dedup_key));
        if (engine.DRY_RUN) { totalDeleted += orphans.length; continue; }
        for (const o of orphans) {
            const { error } = await websiteSupabase.from(t.name).delete().eq('id', o.id);
            if (!error) totalDeleted++;
        }
    }
    await interaction.editReply({
        content: engine.DRY_RUN ? `[DRY RUN] Would delete ${totalDeleted} orphans.` : `✅ Force-pruned ${totalDeleted} orphan(s).`
    });
    auditLog('website_sync', `Force-pruned ${totalDeleted} orphan(s)`, { deleted: totalDeleted }, 'warn');
}

const commands = [
    new SlashCommandBuilder()
        .setName('website-sync')
        .setDescription('Manage website sync')
        .addSubcommand((sub) => sub.setName('now').setDescription('Trigger an immediate sync (events + jobs)'))
        .addSubcommand((sub) => sub.setName('backfill').setDescription('Force sync of ALL eligible items'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Show last sync info'))
        .addSubcommand((sub) => sub.setName('health').setDescription('Verify website matches bot eligible set'))
        .addSubcommand((sub) => sub.setName('prune').setDescription('Force-delete orphans (bypasses threshold guard)'))
];

async function handleCommand(interaction, bot) {
    if (!engine.isConfigured()) return interaction.reply({ content: '❌ Website sync not configured', flags: MessageFlags.Ephemeral });
    if (!engine.isEnabled()) return interaction.reply({ content: '❌ Website sync disabled', flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();
    if (sub === 'now' || sub === 'backfill') return handleNow(bot, interaction);
    if (sub === 'status') return handleStatus(bot, interaction);
    if (sub === 'health') return handleHealth(bot, interaction);
    if (sub === 'prune') return handlePrune(bot, interaction);
}

module.exports = { commands, handleCommand };
