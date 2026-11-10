// src/discord/extensions/undo-edit.js
// Two live-post management commands:
//   /undo       — delete a live message + restore the item to pending
//   /edit-live  — edit a live message in place (no delete/repost)
//
// Both need to locate the Discord message. Two paths, in order:
//   1. bot._ext.recentPosts — the in-memory registry of the 20 most
//      recent live posts, keyed by eventId + messageId. Fast, but lost
//      on restart.
//   2. findLiveMessageForEvent — scan the last 25 messages of every live
//      channel for one whose title matches the item. Slow but survives
//      restarts.
//
// After a message is found, everything else is Discord API surface.

const { SlashCommandBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { auditLog } = require('../../core/auditLogger');

async function findLiveMessageForEvent(bot, event) {
    const normalizedTarget = bot.normalizeEventName(event.title || '');
    if (!normalizedTarget) return null;

    for (const channelId of Object.values(bot.CATEGORIES).map((c) => c.main).filter(Boolean)) {
        try {
            const channel = await bot.client.channels.fetch(channelId);
            const fetched = await channel.messages.fetch({ limit: 25 });
            for (const msg of fetched.values()) {
                if (!bot.client.user || !msg.author || msg.author.id !== bot.client.user.id) continue;
                const firstLine = (msg.content || '').split('\n')[0] || '';
                const match = firstLine.match(/^##\s*(?:<a?:\w+:\d+>\s*)?(.+)$/);
                if (!match) continue;
                if (bot.normalizeEventName(match[1].trim()) === normalizedTarget) {
                    return { channel, message: msg };
                }
            }
        } catch (e) { /* try next channel */ }
    }
    return null;
}

async function handleUndo(bot, interaction) {
    const query = interaction.options.getString('query');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let event, registryEntry;
    if (query) {
        const q = query.toLowerCase();
        const matches = (bot.cache.postedEvents || []).filter((e) => (e.title || '').toLowerCase().includes(q));
        if (matches.length === 0) return interaction.editReply({ content: `❌ No posted item found matching "${query}".` });
        if (matches.length > 1) {
            const lines = matches.slice(0, 10).map((e) => `• ${e.title} (id: \`${e.id}\`)`);
            return interaction.editReply({ content: `🔍 Multiple matches:\n${lines.join('\n')}` });
        }
        event = matches[0];
        registryEntry = (bot._ext.recentPosts || []).find((p) => p.eventId === event.id);
    } else {
        registryEntry = (bot._ext.recentPosts || []).find((p) => p.mode === 'main');
        if (!registryEntry) return interaction.editReply({ content: '❌ No recent live post in memory — try `/undo query:<title>`.' });
        event = (bot.cache.postedEvents || []).find((e) => e.id === registryEntry.eventId);
        if (!event) return interaction.editReply({ content: `❌ "${registryEntry.title}" is no longer in posted-events (already undone?).` });
    }

    let found = null;
    if (registryEntry && registryEntry.messageId) {
        try {
            const channel = await bot.client.channels.fetch(registryEntry.channelId);
            const message = await channel.messages.fetch(registryEntry.messageId);
            found = { channel, message };
        } catch (e) { /* fall through */ }
    }
    if (!found) found = await findLiveMessageForEvent(bot, event);

    let deletedMessage = false;
    let channelId = registryEntry ? registryEntry.channelId : (found ? found.channel.id : null);
    if (found) {
        try {
            await found.message.delete();
            deletedMessage = true;
            channelId = found.channel.id;
        } catch (error) {
            console.warn('⚠️ /undo could not delete the message:', error.message);
        }
    }

    const idx = bot.cache.postedEvents.findIndex((e) => e.id === event.id);
    if (idx !== -1) bot.cache.postedEvents.splice(idx, 1);
    if (channelId) bot.releasePostedMarker(event, channelId);
    bot.cache.postedEventKeys = (bot.cache.postedEventKeys || []).filter((k) => k !== bot.getEventDedupKey(event));
    event.firstSeenAt = Date.now();
    delete event.testPosted;
    delete event.testPostedAt;
    bot.cache.pendingEvents.push(event);
    bot.saveCache();
    bot._ext.recentPosts = (bot._ext.recentPosts || []).filter((p) => p.eventId !== event.id);

    await interaction.editReply({ content: `↩️ Undid "${event.title}" — ${deletedMessage ? 'live message deleted and ' : "(couldn't find/delete the original, but) "}item is back in /pending.` });
    await bot.sendLogMessage(`↩️ /undo by ${interaction.user.tag} — reverted "${event.title}" back to pending.`);
    auditLog('undo_post', `Reverted live post for "${event.title}"`, { eventId: event.id, title: event.title, channelId, messageId: registryEntry?.messageId || null }, 'warn');
}

async function handleEditLive(bot, interaction) {
    const query = interaction.options.getString('query', true).toLowerCase();
    const matches = (bot.cache.postedEvents || []).filter((e) => (e.title || '').toLowerCase().includes(query));
    if (matches.length === 0) return interaction.reply({ content: `❌ No posted item matching "${query}".`, flags: MessageFlags.Ephemeral });
    if (matches.length > 1) {
        const lines = matches.slice(0, 10).map((e) => `• ${e.title} (id: \`${e.id}\`)`);
        return interaction.reply({ content: `🔍 Multiple matches:\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }
    const event = matches[0];

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const found = await findLiveMessageForEvent(bot, event);
    if (!found) return interaction.editReply({ content: `❌ Couldn't locate the live message for "${event.title}".` });

    const modal = new ModalBuilder()
        .setCustomId(`ext_edit_live:${found.channel.id}:${found.message.id}:${event.id}`)
        .setTitle('Edit Live Post');
    const titleInput = new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(event.title || '').setRequired(true);
    const descInput = new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(event.description || '').setRequired(false);
    const dateInput = new TextInputBuilder().setCustomId('date').setLabel('Date & Time').setStyle(TextInputStyle.Short).setValue(event.date || '').setRequired(false);
    const locationInput = new TextInputBuilder().setCustomId('location').setLabel('Location').setStyle(TextInputStyle.Short).setValue(event.location || '').setRequired(false);
    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(dateInput),
        new ActionRowBuilder().addComponents(locationInput)
    );

    await interaction.editReply({ content: '📝 Opening the edit form...' });
    await interaction.showModal(modal);
}

async function handleEditLiveModalSubmit(bot, interaction) {
    const [, channelId, messageId, eventId] = interaction.customId.split(':');
    const event = (bot.cache.postedEvents || []).find((e) => e.id === eventId);
    if (!event) return interaction.reply({ content: '❌ That item is no longer in posted-events.', flags: MessageFlags.Ephemeral });

    event.title = interaction.fields.getTextInputValue('title');
    event.description = interaction.fields.getTextInputValue('description') || '';
    event.date = interaction.fields.getTextInputValue('date') || '';
    event.location = interaction.fields.getTextInputValue('location') || '';
    bot.sanitizeEventFields(event);
    bot.saveCache();

    try {
        const channel = await bot.client.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        const newContent = bot.formatEventMessage(event);
        await message.edit({ content: newContent });
        await interaction.reply({ content: `✅ Live message for "${event.title}" updated.`, flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`✏️ /edit-live by ${interaction.user.tag} — updated "${event.title}".`);
        auditLog('edit_live_post', `Edited live post for "${event.title}"`, { eventId: event.id, channelId, messageId }, 'warn');
    } catch (error) {
        await interaction.reply({ content: `❌ Saved the updated data, but failed to edit the Discord message: ${error.message}`, flags: MessageFlags.Ephemeral });
    }
}

const definitions = [
    new SlashCommandBuilder().setName('undo').setDescription('Undo a LIVE post — deletes the message and restores the item to pending')
        .addStringOption((opt) => opt.setName('query').setDescription('Title text to search for (default: most recent)').setRequired(false)),
    new SlashCommandBuilder().setName('edit-live').setDescription('Edit an already-posted LIVE message in place')
        .addStringOption((opt) => opt.setName('query').setDescription('Title text to search for among posted items').setRequired(true))
];

const handlers = { undo: handleUndo, 'edit-live': handleEditLive };
const modalHandlers = { 'ext_edit_live': handleEditLiveModalSubmit };

module.exports = { definitions, handlers, modalHandlers, findLiveMessageForEvent };
