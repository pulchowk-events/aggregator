// scripts/setup/discord-create.js
// Channel + role creation for the setup wizard.
//
// EVERY function supports a `dryRun` flag. In dry-run mode:
//   - existing items are found and reported
//   - missing items are reported as "would create" with their would-be name
//   - NO API mutations are made
// The wizard calls these in dry-run mode first, shows a diff, and only
// calls them for real after explicit confirmation.
//
// Idempotency: all find-or-create helpers check by name first. Running
// the wizard twice will not create duplicates.

const { ChannelType } = require('discord.js');

// Find a text channel by name within a parent category, or null.
async function findTextChannel(guild, name, { parentId = null } = {}) {
    await guild.channels.fetch();
    const lowerName = name.toLowerCase();
    return guild.channels.cache.find((c) =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.name.toLowerCase() === lowerName &&
        (parentId === null || c.parentId === parentId)
    ) || null;
}

// Find a role by name, or null.
async function findRole(guild, name) {
    await guild.roles.fetch();
    const lowerName = name.toLowerCase();
    return guild.roles.cache.find((r) => r.name.toLowerCase() === lowerName) || null;
}

// Find a category by name, or null.
async function findCategory(guild, name) {
    await guild.channels.fetch();
    const lowerName = name.toLowerCase();
    return guild.channels.cache.find((c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toLowerCase() === lowerName
    ) || null;
}

// Idempotent category creation. Returns { ok, category, created, dryRun }.
async function ensureCategory(guild, name, { dryRun = false } = {}) {
    const existing = await findCategory(guild, name);
    if (existing) return { ok: true, category: { id: existing.id, name: existing.name }, created: false, dryRun };
    if (dryRun) return { ok: true, category: { id: '(new)', name }, created: false, wouldCreate: true, dryRun };
    try {
        const channel = await guild.channels.create({ name, type: ChannelType.GuildCategory });
        return { ok: true, category: { id: channel.id, name: channel.name }, created: true, dryRun };
    } catch (error) {
        return { ok: false, error: error.message, dryRun };
    }
}

// Idempotent text-channel creation within a category. If parentId is null,
// the channel is created without a parent (top-level).
async function ensureTextChannel(guild, name, { parentId = null, topic = null, dryRun = false } = {}) {
    const existing = await findTextChannel(guild, name, { parentId });
    if (existing) return { ok: true, channel: { id: existing.id, name: existing.name, parentId: existing.parentId }, created: false, dryRun };
    if (dryRun) return { ok: true, channel: { id: '(new)', name, parentId }, created: false, wouldCreate: true, dryRun };
    try {
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: parentId || undefined,
            topic: topic || undefined
        });
        return { ok: true, channel: { id: channel.id, name: channel.name, parentId: channel.parentId }, created: true, dryRun };
    } catch (error) {
        return { ok: false, error: error.message, dryRun };
    }
}

// Idempotent role creation. Color as 0xRRGGBB integer, or null.
async function ensureRole(guild, name, { color = null, dryRun = false } = {}) {
    const existing = await findRole(guild, name);
    if (existing) return { ok: true, role: { id: existing.id, name: existing.name }, created: false, dryRun };
    if (dryRun) return { ok: true, role: { id: '(new)', name }, created: false, wouldCreate: true, dryRun };
    try {
        const role = await guild.roles.create({
            name,
            color: color || undefined,
            reason: 'Setup wizard'
        });
        return { ok: true, role: { id: role.id, name: role.name }, created: true, dryRun };
    } catch (error) {
        return { ok: false, error: error.message, dryRun };
    }
}

// Plan (dry-run) the full set of channel + role operations the wizard
// wants to perform, given the user's choices. Returns a structure the
// caller can display and confirm before running the real creates.
//
// choices: {
//   categories: [{ key: 'sports', categoryName: 'Events', main: 'sports', test: 'sports-test' }, ...]
//   roles: [{ key: 'sports', name: 'Sports Ping', color: 0x00AE86 }, ...]
//   createCategory: bool,
//   createChannels: bool,
//   createRoles: bool
// }
async function planSetup(guild, choices) {
    const plan = { categories: [], channels: [], roles: [] };

    if (choices.createCategory) {
        for (const cat of choices.categories) {
            const found = await findCategory(guild, cat.categoryName);
            plan.categories.push({
                key: cat.key,
                name: cat.categoryName,
                exists: Boolean(found),
                existingId: found ? found.id : null,
                willCreate: !found
            });
        }
    }

    if (choices.createChannels) {
        for (const cat of choices.categories) {
            const parent = choices.createCategory ? null : await findCategory(guild, cat.categoryName);
            const parentId = parent ? parent.id : null;
            for (const [field, chName] of [['main', cat.main], ['test', cat.test]]) {
                if (!chName) continue;
                const found = await findTextChannel(guild, chName, { parentId });
                plan.channels.push({
                    key: cat.key,
                    field,
                    name: chName,
                    parentName: cat.categoryName,
                    exists: Boolean(found),
                    existingId: found ? found.id : null,
                    willCreate: !found
                });
            }
        }
    }

    if (choices.createRoles) {
        for (const role of choices.roles) {
            const found = await findRole(guild, role.name);
            plan.roles.push({
                key: role.key,
                name: role.name,
                exists: Boolean(found),
                existingId: found ? found.id : null,
                willCreate: !found
            });
        }
    }

    return plan;
}

// Execute a plan. Returns a map of { channelId/roleId/categoryId } by key.
async function executePlan(guild, choices) {
    const result = { categories: {}, channels: {}, roles: {}, errors: [] };

    if (choices.createCategory) {
        for (const cat of choices.categories) {
            const r = await ensureCategory(guild, cat.categoryName);
            if (r.ok) result.categories[cat.key] = r.category.id;
            else result.errors.push({ phase: 'category', key: cat.key, error: r.error });
        }
    }

    if (choices.createChannels) {
        for (const cat of choices.categories) {
            const parent = await findCategory(guild, cat.categoryName);
            const parentId = parent ? parent.id : null;
            result.channels[cat.key] = {};
            for (const [field, chName] of [['main', cat.main], ['test', cat.test]]) {
                if (!chName) continue;
                const r = await ensureTextChannel(guild, chName, { parentId });
                if (r.ok) result.channels[cat.key][field] = r.channel.id;
                else result.errors.push({ phase: 'channel', key: cat.key, field, error: r.error });
            }
        }
    }

    if (choices.createRoles) {
        for (const role of choices.roles) {
            const r = await ensureRole(guild, role.name, { color: role.color || null });
            if (r.ok) result.roles[role.key] = r.role.id;
            else result.errors.push({ phase: 'role', key: role.key, error: r.error });
        }
    }

    return result;
}

module.exports = {
    findTextChannel, findRole, findCategory,
    ensureCategory, ensureTextChannel, ensureRole,
    planSetup, executePlan
};
