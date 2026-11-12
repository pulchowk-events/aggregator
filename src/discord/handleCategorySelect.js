// src/discord/handleCategorySelect.js
// sendCategoryPicker     — first step. Fetches channels, builds the select
//                          menu, marks already-posted categories with ⚠️,
//                          marks suggested category.
// handleCategorySelect   — second step. Selection triggers either a confirm
//                          row or a force-confirm row (if already posted).
// Neither function posts. Confirmation is a separate click routed through
// handleConfirmPost.

const { StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

async function resolveCategoryChannelInfo(bot, mode) {
    const out = [];
    for (const [key, cat] of Object.entries(bot.CATEGORIES)) {
        const channelId = mode === 'main' ? cat.main : cat.test;
        if (!channelId) continue;
        try {
            const channel = await bot.client.channels.fetch(channelId);
            out.push({ key, channelId, channelName: (channel && channel.name) || 'unknown-channel' });
        } catch (error) {
            out.push({ key, channelId, channelName: null, unreachable: true });
        }
    }
    return out;
}

async function sendCategoryPicker(bot, interaction, mode, event) {
    bot.sanitizeEventFields(event);

    if (mode === 'main' && !bot.hasValidImage(event)) {
        return interaction.reply({
            content: `❌ **"${event.title}"** has no image, so it can't go to a LIVE channel. Add one via **Customize** first, or post it to Test only.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const suggestedKey = bot.determineCategory(event);
    const channelInfos = await resolveCategoryChannelInfo(bot, mode);
    const selectable = channelInfos.filter((c) => !c.unreachable);

    if (selectable.length === 0) {
        return interaction.reply({
            content: `❌ No ${mode === 'main' ? 'live' : 'test'} channels are configured/reachable for any category.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const alreadyPostedFlags = await Promise.all(selectable.map((c) => bot.hasBeenPostedToChannel(event, c.channelId)));

    const options = selectable.map((c, i) => {
        const alreadyPosted = alreadyPostedFlags[i];
        return {
            label: c.key.charAt(0).toUpperCase() + c.key.slice(1) + (c.key === suggestedKey ? ' (suggested)' : '') + (alreadyPosted ? ' ⚠️ already posted' : ''),
            description: `#${c.channelName}  •  ID: ${c.channelId}`.slice(0, 100),
            value: c.key
        };
    });

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`pick_category:${mode}:${event.id}`)
        .setPlaceholder(`Choose a category${suggestedKey ? ` (suggested: ${suggestedKey})` : ''}`)
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);

    const dataQualityNote = bot.hasDataQualityWarnings(event)
        ? `\n\n⚠️ **This item has data-quality warnings:**\n${event.dataQualityWarnings.map((w) => `• ${w}`).join('\n')}`
        : '';
    const leadTimeNote = bot.isEventTooSoon(event)
        ? `\n\n⏳ **This item is less than ${bot.getAutopostMinLeadDays()} day(s) away** — registration is likely closing/closed. Autopost would never send this; only post it manually if you're sure it's still valid.`
        : '';
    const warningNote = dataQualityNote + leadTimeNote;

    await interaction.reply({
        content: `Posting **"${event.title}"** to ${mode === 'main' ? 'a live' : 'a test'} channel — pick the category/channel (you'll confirm on the next step, nothing posts yet):${warningNote}`,
        components: [row],
        flags: MessageFlags.Ephemeral
    });
}

async function handleCategorySelect(bot, interaction) {
    if (!require('./admin').isAdmin(bot, interaction)) {
        return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
    }

    const parts = interaction.customId.split(':');
    const [, mode, ...eventIdParts] = parts;
    const eventId = eventIdParts.join(':');
    const categoryKey = interaction.values[0];

    const event = bot.cache.pendingEvents.find((e) => e.id === eventId);
    if (!event) {
        return interaction.update({ content: '❌ Item not found — may have already been posted or skipped.', components: [] });
    }

    bot.sanitizeEventFields(event);

    const category = bot.CATEGORIES[categoryKey];
    if (!category) {
        // Guard against stale select-menu interactions — the customId was
        // built when a category existed that has since been removed, or the
        // interaction payload was tampered with. Fail with a clear message
        // instead of silently rendering "unknown" and then failing on post.
        return interaction.update({
            content: `❌ Unknown category "${categoryKey}" — the command may be stale. Run \`/pending\` again.`,
            components: []
        });
    }
    const channelId = mode === 'main' ? category.main : category.test;
    let channelName = 'unknown';
    if (channelId) {
        try {
            const channel = await bot.client.channels.fetch(channelId);
            channelName = (channel && channel.name) || 'unknown';
        } catch (error) { /* keep 'unknown' */ }
    }

    const alreadyPosted = channelId ? await bot.hasBeenPostedToChannel(event, channelId) : false;

    if (alreadyPosted) {
        const when = bot.lastPostedToChannelAt(event, channelId);
        const whenText = when ? `<t:${Math.floor(when / 1000)}:R>` : 'recently (or a post to this channel is currently in progress)';
        const forceRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_post_force:${mode}:${categoryKey}:${eventId}`).setLabel('Yes, post it again anyway').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`cancel_post:${eventId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );

        return interaction.update({
            content: `🚨 **"${event.title}"** was already posted to **${categoryKey}** — #${channelName} (\`${channelId}\`) ${whenText}.\n\nThe bot will not repost this automatically. If you specifically want to send it to this channel again, confirm below — otherwise cancel.`,
            components: [forceRow]
        });
    }

    const dataQualityNote = bot.hasDataQualityWarnings(event)
        ? `\n\n⚠️ **Data-quality warning(s) on this item:**\n${event.dataQualityWarnings.map((w) => `• ${w}`).join('\n')}\nDouble-check the preview before confirming.`
        : '';
    const leadTimeNote = bot.isEventTooSoon(event)
        ? `\n\n⏳ **This item is less than ${bot.getAutopostMinLeadDays()} day(s) away.** Double-check it's still valid before confirming.`
        : '';
    const warningNote = dataQualityNote + leadTimeNote;

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_post:${mode}:${categoryKey}:${eventId}`).setLabel('Confirm & Post').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cancel_post:${eventId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({
        content: `Ready to post **"${event.title}"** to **${categoryKey}** — #${channelName} (\`${channelId}\`), ${mode === 'main' ? 'LIVE' : 'TEST'} channel.\n\nNothing has been posted yet — confirm to send, or cancel.${warningNote}`,
        components: [confirmRow]
    });
}

module.exports = { sendCategoryPicker, handleCategorySelect };
