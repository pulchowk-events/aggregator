// scripts/setup/discord.js
// Discord-side helpers for the setup wizard.
//
// Batch 1 scope: connect, list guilds, list channels, list roles. NO
// creation, NO mutation — read-only probes only. Creation lives in a
// separate module (batch 2) so an error here can't accidentally nuke a
// live server.
//
// The wizard passes an explicit token; it does NOT read .env. That
// separation matters: setup must work when .env doesn't exist yet.

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

const READY_TIMEOUT_MS = 20000;

async function connect(token) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { client.destroy(); } catch (e) {}
            reject(new Error(`Login timed out after ${READY_TIMEOUT_MS / 1000}s — check the token and your network.`));
        }, READY_TIMEOUT_MS);

        client.once('ready', () => {
            clearTimeout(timer);
            resolve(client);
        });
        client.once('error', (err) => {
            clearTimeout(timer);
            try { client.destroy(); } catch (e) {}
            reject(err);
        });

        client.login(token).catch((err) => {
            clearTimeout(timer);
            try { client.destroy(); } catch (e) {}
            reject(err);
        });
    });
}

async function disconnect(client) {
    if (!client) return;
    try { await client.destroy(); } catch (e) {}
}

// Guilds the bot is currently a member of.
function listGuilds(client) {
    return client.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount || 0,
        ownerId: g.ownerId || null
    }));
}

// Fetch (with cache fallback) a guild by ID.
async function getGuild(client, guildId) {
    return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
}

// All text-based channels, grouped by category, sorted for display.
async function listTextChannels(guild) {
    await guild.channels.fetch();
    const text = guild.channels.cache
        .filter((c) => c.type === 0 /* GuildText */ || c.type === 5 /* GuildAnnouncement */)
        .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type === 5 ? 'announcement' : 'text',
            parentId: c.parentId || null,
            parentName: c.parentId ? (guild.channels.cache.get(c.parentId)?.name || null) : null,
            position: c.rawPosition || 0
        }))
        .sort((a, b) => {
            if (a.parentName !== b.parentName) return (a.parentName || '').localeCompare(b.parentName || '');
            return a.position - b.position;
        });
    return text;
}

// All categories (channel groups), sorted by position.
async function listCategories(guild) {
    await guild.channels.fetch();
    return guild.channels.cache
        .filter((c) => c.type === 4 /* GuildCategory */)
        .map((c) => ({ id: c.id, name: c.name, position: c.rawPosition || 0 }))
        .sort((a, b) => a.position - b.position);
}

// All roles, sorted by position (highest first, like Discord shows them).
// Excludes @everyone (id === guild.id).
async function listRoles(guild) {
    await guild.roles.fetch();
    return guild.roles.cache
        .filter((r) => r.id !== guild.id)
        .map((r) => ({
            id: r.id,
            name: r.name,
            color: r.hexColor,
            position: r.rawPosition || 0,
            managed: r.managed
        }))
        .sort((a, b) => b.position - a.position);
}

// Does the bot have the permissions needed to create + configure the
// things the wizard wants to create? Returns a structured verdict.
async function checkPermissions(guild) {
    const me = await guild.members.fetchMe();
    const p = me.permissions;
    const result = {
        canManageChannels: p.has(PermissionFlagsBits.ManageChannels),
        canManageRoles:    p.has(PermissionFlagsBits.ManageRoles),
        canManageGuild:    p.has(PermissionFlagsBits.ManageGuild),
        isAdmin:           p.has(PermissionFlagsBits.Administrator)
    };
    result.readyToCreate = result.canManageChannels && result.canManageRoles;
    return { ...result, memberTag: me.user.tag, memberId: me.id };
}

// Human-readable label for a channel row, used in TUI menus.
function channelLabel(c) {
    const parent = c.parentName ? `${c.parentName} / ` : '';
    return `${parent}#${c.name}`
        + (c.type === 'announcement' ? '  [announcement]' : '')
        + `  (${c.id})`;
}

// Human-readable label for a role row.
function roleLabel(r) {
    return `@${r.name}  (${r.id})` + (r.managed ? '  [managed by integration]' : '');
}

module.exports = {
    connect, disconnect,
    listGuilds, getGuild,
    listTextChannels, listCategories, listRoles,
    checkPermissions,
    channelLabel, roleLabel
};
