// src/discord/extensions/index.js
// The botExtensions attach point — port of the original botExtensions.js,
// split across the sibling files in this directory.
//
// What attach() does, in order:
//
//   1. Initialize bot._ext state (recentPosts registry, pendingCleanups map).
//   2. Wrap interactionCreate. Ext-prefixed interactions (commands defined
//      in helpers/diagnostics/dedupe/undo-edit/cleanup/admin-toggles +
//      modal submits + cleanup buttons) are handled HERE and return early.
//      Everything else gets replayed through the base listeners — so
//      bot.js's own handler still processes /scrape, /pending, buttons,
//      select menus, and the customize modal exactly as before.
//   3. Wrap postEventToCategory. Successful LIVE post → sequenced
//      dedupe → publish. This is what guarantees no duplicate gets
//      crossposted before the dedupe sweep clears it.
//   4. Wrap _processScrapedEventsLocked. After the base pipeline runs,
//      newly-scraped items matching the blacklist get auto-skipped.
//   5. Attach the connection watchdog.
//   6. Register extension commands via REST POST (create-or-update one
//      command by name, never touching the base commands).

const { REST, Routes, MessageFlags } = require('discord.js');
const env = require('../../config/env');

const helpers = require('./helpers');
const diagnostics = require('./diagnostics');
const dedupe = require('./dedupe');
const undoEdit = require('./undo-edit');
const cleanup = require('./cleanup');
const adminToggles = require('./admin-toggles');
const { sequencedPostPublish } = require('./autopublish');
const { attachWatchdog } = require('./watchdog');
const { auditLog } = require('../../core/auditLogger');

// All extension command definitions, merged into one lookup table.
const EXT_DEFINITIONS = [
    ...helpers.definitions,
    ...diagnostics.definitions,
    ...dedupe.definitions,
    ...undoEdit.definitions,
    ...cleanup.definitions,
    ...adminToggles.definitions
];

const EXT_HANDLERS = {
    ...helpers.handlers,
    ...diagnostics.handlers,
    ...dedupe.handlers,
    ...undoEdit.handlers,
    ...cleanup.handlers,
    ...adminToggles.handlers
};

const EXT_MODAL_HANDLERS = {
    ...undoEdit.modalHandlers
};

const EXT_COMMAND_NAMES = new Set(EXT_DEFINITIONS.map((d) => d.name));

// ---------- Interaction routing ----------

function attachInteractionRouter(bot) {
    const originalListeners = bot.client.listeners('interactionCreate');
    bot.client.removeAllListeners('interactionCreate');

    bot.client.on('interactionCreate', async (interaction) => {
        const isExtCommand = interaction.isChatInputCommand && interaction.isChatInputCommand() && EXT_COMMAND_NAMES.has(interaction.commandName);
        const isExtModal = interaction.isModalSubmit && interaction.isModalSubmit() && isExtModalId(interaction.customId);
        const isExtButton = interaction.isButton && interaction.isButton() && isExtButtonId(interaction.customId);

        if (!isExtCommand && !isExtModal && !isExtButton) {
            for (const original of originalListeners) {
                await original(interaction);
            }
            return;
        }

        try {
            if (!require('../admin').isAdmin(bot, interaction)) {
                return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
            }

            if (isExtCommand) {
                const handler = EXT_HANDLERS[interaction.commandName];
                if (typeof handler === 'function') return handler(bot, interaction);
                return interaction.reply({ content: `❌ Unknown extension command "${interaction.commandName}".`, flags: MessageFlags.Ephemeral });
            }

            if (isExtModal) {
                const action = interaction.customId.split(':')[0];
                const handler = EXT_MODAL_HANDLERS[action];
                if (typeof handler === 'function') return handler(bot, interaction);
            }

            if (isExtButton) {
                if (interaction.customId.startsWith('ext_cleanup_')) {
                    return require('./cleanup').handleCleanupButton(bot, interaction);
                }
            }
        } catch (error) {
            if (error.code === 10062) return;
            console.error('❌ [ext] Unhandled interaction error:', error);
            try {
                const payload = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
                if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
                else await interaction.reply(payload);
            } catch (e) { /* ignore */ }
        }
    });
}

function isExtModalId(id) {
    const action = id.split(':')[0];
    return Object.keys(EXT_MODAL_HANDLERS).includes(action);
}

function isExtButtonId(id) {
    return id.startsWith('ext_cleanup_confirm:') || id.startsWith('ext_cleanup_cancel:');
}

// ---------- postEventToCategory post-hook ----------

function attachPostHooks(bot) {
    const original = bot.postEventToCategory.bind(bot);
    bot.postEventToCategory = async function patchedPostEventToCategory(event, mode, categoryKeyOverride = null, force = false) {
        const result = await original(event, mode, categoryKeyOverride, force);
        if (result && result.ok && mode === 'main') {
            try {
                // Look up the actual channel id so the post-hook knows where
                // to scan. resolveChannelId is the same helper post.js uses.
                const categoryKey = categoryKeyOverride || bot.determineCategory(event);
                const cat = bot.CATEGORIES[categoryKey];
                const channelId = cat && cat.main;
                if (channelId) {
                    // Record in the recent-posts registry FIRST — undo/edit
                    // need it before the dedupe scan completes.
                    try {
                        const channel = await bot.client.channels.fetch(channelId);
                        const recent = await channel.messages.fetch({ limit: 1 });
                        const msg = recent.first();
                        bot._ext.recentPosts.unshift({
                            eventId: event.id,
                            title: event.title,
                            channelId,
                            messageId: msg ? msg.id : null,
                            categoryKey,
                            mode,
                            postedAt: Date.now()
                        });
                        bot._ext.recentPosts = bot._ext.recentPosts.slice(0, 20);
                    } catch (error) {
                        console.warn('⚠️ [ext] could not record recent-post reference:', error.message);
                    }

                    await sequencedPostPublish(bot, event, mode, categoryKey, channelId);
                }
            } catch (error) {
                console.error('❌ [ext] post-publish sequence failed:', error);
            }
        }
        return result;
    };
}

// ---------- Blacklist filter on scrape ----------

function attachBlacklistFilter(bot) {
    const original = bot._processScrapedEventsLocked.bind(bot);
    bot._processScrapedEventsLocked = async function patchedProcessScrapedEventsLocked(events, errors) {
        const beforeIds = new Set(bot.cache.pendingEvents.map((e) => e.id));
        const result = await original(events, errors);

        try {
            const blacklist = bot.cache.settings.blacklist || { keywords: [], organizers: [] };
            const hasRules = (blacklist.keywords && blacklist.keywords.length) || (blacklist.organizers && blacklist.organizers.length);
            if (!hasRules) return result;

            const stillPending = [];
            const autoSkipped = [];
            for (const event of bot.cache.pendingEvents) {
                if (beforeIds.has(event.id)) { stillPending.push(event); continue; }
                const haystack = `${event.title || ''} ${event.description || ''}`.toLowerCase();
                const org = (event.organizer || '').toLowerCase();
                const kwHit = (blacklist.keywords || []).some((kw) => kw && haystack.includes(kw.toLowerCase()));
                const orgHit = (blacklist.organizers || []).some((o) => o && org.includes(o.toLowerCase()));
                if (kwHit || orgHit) autoSkipped.push(event);
                else stillPending.push(event);
            }

            if (autoSkipped.length > 0) {
                bot.cache.pendingEvents = stillPending;
                bot.cache.skippedEvents = bot.cache.skippedEvents || [];
                bot.cache.skippedEvents.push(...autoSkipped);
                bot.saveCache();
                await bot.sendLogMessage(`🚫 Blacklist auto-skipped ${autoSkipped.length} newly-scraped item(s): ${autoSkipped.map((e) => `"${e.title}"`).join(', ')}`);
                auditLog('blacklist_filter', `Auto-skipped ${autoSkipped.length} newly-scraped item(s)`, {
                    count: autoSkipped.length,
                    events: autoSkipped.map((e) => ({ id: e.id, title: e.title, organizer: e.organizer || null }))
                }, 'warn');
            }
        } catch (error) {
            console.error('❌ [ext] blacklist filter failed:', error);
        }
        return result;
    };
}

// ---------- Slash command registration (REST POST) ----------

function registerExtensionCommands(bot) {
    bot.client.once('ready', async () => {
        try {
            if (!env.HOME_GUILD_ID) {
                console.error('❌ [ext] HOME_GUILD_ID not set — refusing to register extension commands globally.');
                return;
            }
            const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
            // Register extension commands GUILD-SCOPED to HOME_GUILD_ID only.
            // POST (not bulk PUT) creates-or-updates each command by name without
            // touching any other command — so this never clobbers the base commands.
            for (const cmd of EXT_DEFINITIONS) {
                await rest.post(
                    Routes.applicationGuildCommands(bot.client.user.id, env.HOME_GUILD_ID),
                    { body: cmd.toJSON() }
                );
            }
            console.log(`✅ [ext] Registered ${EXT_DEFINITIONS.length} extension command(s) to guild ${env.HOME_GUILD_ID} only.`);
        } catch (error) {
            console.error('❌ [ext] Failed to register extension commands:', error);
        }
    });
}

// ---------- attach ----------

function attachExtensions(bot) {
    if (!bot || !bot.client) {
        throw new Error('[ext] attachExtensions(bot) requires a constructed EventsBot.');
    }

    bot._ext = bot._ext || {};
    bot._ext.recentPosts = bot._ext.recentPosts || [];
    bot._ext.pendingCleanups = bot._ext.pendingCleanups || new Map();

    attachInteractionRouter(bot);
    attachPostHooks(bot);
    attachBlacklistFilter(bot);
    attachWatchdog(bot);
    registerExtensionCommands(bot);

    console.log(`🧩 [ext] Attached ${EXT_DEFINITIONS.length} command(s) + dedupe/autopublish/blacklist/watchdog.`);
    return bot;
}

module.exports = attachExtensions;
