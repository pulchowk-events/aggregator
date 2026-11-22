'use strict';
// /club add|remove|list|fetch|refresh  -- manage tracked Instagram clubs, run a fetch+post.
// Admin only (Discord permission + ADMIN_USER_IDS). All replies ephemeral.
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const social = require('../../posting/socialPost');
const schedule = require('../../posting/socialSchedule');

const EPHEMERAL = MessageFlags.Ephemeral;
const OK = '\u2705', NO = '\u274C', LOCK = '\u26D4', WARN = '\u26A0\uFE0F';

const definition = new SlashCommandBuilder()
    .setName('club')
    .setDescription('Manage tracked Instagram clubs (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) => sc.setName('add').setDescription('Track an Instagram club')
        .addStringOption((o) => o.setName('username').setDescription('Instagram username').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Display name (default: username)')))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Stop tracking a club')
        .addStringOption((o) => o.setName('username').setDescription('Instagram username').setRequired(true)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List tracked clubs'))
    .addSubcommand((sc) => sc.setName('fetch').setDescription('Scrape tracked clubs now and post new items')
        .addBooleanOption((o) => o.setName('sample').setDescription('Include a sample item in the reply (default: true)')))
    .addSubcommand((sc) => sc.setName('refresh').setDescription('Re-fetch a club\'s profile picture and display name')
        .addStringOption((o) => o.setName('username').setDescription('Instagram username').setRequired(true)));

const adminIds = (env) => String(env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
let busy = false;

function resolveSource() {
    const dir = path.join(__dirname, '..', '..', 'scrapers', 'sources', 'social');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !/example|test/i.test(f));
    files.sort((a, b) => (/insta/i.test(b) ? 1 : 0) - (/insta/i.test(a) ? 1 : 0));
    for (const f of files) {
        const mod = require(path.join(dir, f));
        if (mod && typeof mod.scrape === 'function') return mod;
    }
    throw new Error('No scrape() source found in src/scrapers/sources/social/');
}

function resolveWithPage() {
    const w = require('../../scrapers/browser').withPage;
    if (typeof w !== 'function') throw new Error('src/scrapers/browser.js does not export withPage.');
    return w;
}

// Tolerant no-op progress: works whether the source calls progress(...) or progress.something(...).
const noop = () => {};
const progress = new Proxy(noop, { get: (t, k) => (k === 'then' ? undefined : noop) });

// Shared by /club fetch and the scheduler. Owns the busy lock so they cannot overlap.
// opts.only restricts the run to one club (passed to the extractor via IG_ONLY_CLUB, under the lock).
async function runClubFetch(bot, opts = {}) {
    if (busy) return { busy: true };
    busy = true;
    const had = Object.prototype.hasOwnProperty.call(process.env, 'IG_ONLY_CLUB');
    const prev = process.env.IG_ONLY_CLUB;
    try {
        const store = opts.store || social.clubsStore;
        if (!store.list().some((c) => c.enabled)) return { noClubs: true };
        const only = opts.only ? social.normUser(opts.only) : '';
        if (only) process.env.IG_ONLY_CLUB = only; else delete process.env.IG_ONLY_CLUB;
        const source = opts.source || resolveSource();
        const withPage = opts.withPage || resolveWithPage();
        const out = await source.scrape({ withPage, progress, log: console.log });
        const items = (out && out.items) || [];
        const meta = (out && out.meta) || {};
        const client = opts.client || (bot && bot.client);
        if (!client) throw new Error('No Discord client available for posting.');
        const res = await social.postItems(client, items, { bot });
        return { items, meta, res };
    } finally {
        if (had) process.env.IG_ONLY_CLUB = prev; else delete process.env.IG_ONLY_CLUB;
        busy = false;
    }
}

async function handle(bot, interaction, deps = {}) {
    const env = deps.env || process.env;
    const store = deps.store || social.clubsStore;
    const ids = adminIds(env);
    if (!ids.includes(interaction.user.id)) {
        const content = ids.length ? `${LOCK} /club is restricted to bot admins.` : `${LOCK} ADMIN_USER_IDS is not set, so /club is locked.`;
        return interaction.reply({ content, flags: EPHEMERAL });
    }
    const sub = interaction.options.getSubcommand();
    const say = (content) => interaction.reply({ content: String(content).slice(0, 1900), flags: EPHEMERAL });

    try {
        if (sub === 'add') {
            const r = store.add(interaction.options.getString('username', true), {
                label: interaction.options.getString('label') || undefined, by: interaction.user.id
            });
            const msg = { added: `${OK} Added ${r.username}. Run /club refresh ${r.username} to fetch its picture and name.`, reenabled: `${OK} Re-enabled ${r.username}.`, exists: `${WARN} ${r.username} is already tracked.` }[r.status];
            return say(msg);
        }
        if (sub === 'remove') {
            const u = social.normUser(interaction.options.getString('username', true));
            return say(store.remove(u) ? `${OK} Removed ${u}.` : `${WARN} ${u} is not in the list.`);
        }
        if (sub === 'list') {
            const list = store.list();
            if (!list.length) return say('No clubs tracked. Use /club add.');
            const snap = (deps.scheduleStore || schedule.createScheduleStore()).read();
            const now = Date.now();
            const rows = list.map((c) => {
                const nm = c.displayName || (c.label !== c.username ? c.label : '');
                return `- ${c.username}${nm ? ' (' + nm + ')' : ''}${c.enabled ? '' : ' [disabled]'} | ${schedule.describeStatus(snap.data[c.username], now)}`;
            });
            const head = snap.corrupt ? `${WARN} schedule.json is unreadable, scheduler paused.\n` : '';
            return say(head + `Tracked clubs (${list.length}):\n` + rows.join('\n'));
        }
        if (busy) return say('\u23F3 A club fetch/refresh is already running.');

        if (sub === 'refresh') {
            const u = social.normUser(interaction.options.getString('username', true));
            if (!store.list().some((c) => c.username === u)) return say(`${WARN} ${u} is not tracked. Use /club add first.`);
            busy = true;
            try {
                await interaction.deferReply({ flags: EPHEMERAL });
                const r = await social.refreshClub(interaction.client, u);
                const lines = [`${r.errors.length ? WARN : OK} ${u}: name ${r.displayName ? '"' + r.displayName + '"' : 'not found'}, picture ${r.dpBytes ? Math.round(r.dpBytes / 1024) + ' KB saved' : 'not saved'}${r.webhook ? ', webhook ' + r.webhook : ''}.`];
                if (r.errors.length) lines.push(...r.errors.slice(0, 4).map((e) => `${NO} ${e}`));
                return interaction.editReply(lines.join('\n').slice(0, 1900));
            } finally { busy = false; }
        }

        // fetch
        const sample = interaction.options.getBoolean('sample');
        await interaction.deferReply({ flags: EPHEMERAL });
        const r = await runClubFetch(bot, { client: interaction.client, store, source: deps.source, withPage: deps.withPage });
        if (r.busy) return interaction.editReply('\u23F3 A club fetch/refresh is already running.');
        if (r.noClubs) return interaction.editReply('No enabled clubs. Use /club add.');
        const { items, meta, res } = r;
        let msg = items.length
            ? `${OK} ${items.length} new item(s): posted ${res.posted}, duplicate ${res.skipped}, older than 72h ${res.stale}, failed ${res.failed}${res.noImage ? `, without image ${res.noImage}` : ''}.`
            : 'No new items.';
        if (meta.looksBlocked) msg += `\n${WARN} Instagram looked blocked or logged out. Try /insta-login verify.`;
        if (res.errors.length) msg += `\n${NO} ${res.errors[0]}`;
        if (sample !== false && items[0]) {
            const s = items[0];
            msg += `\nSample: ${s.title || s.caption || '(untitled)'} ${s.url || s.link ? '<' + (s.url || s.link) + '>' : ''}`;
        }
        return interaction.editReply(msg.slice(0, 1900));
    } catch (e) {
        const content = `${NO} ${String((e && e.message) || e)}`.slice(0, 1900);
        if (interaction.deferred || interaction.replied) return interaction.editReply(content);
        return interaction.reply({ content, flags: EPHEMERAL });
    }
}

module.exports = { name: 'club', definition, handle, resolveWithPage, runClubFetch };
