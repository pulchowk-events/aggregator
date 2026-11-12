// src/discord/handleConfirmPost.js
// The actual "post it now" action. Two entry points:
//   handleConfirmPost — Confirm & Post (and the force variant); parses
//                       mode/categoryKey/eventId, calls postEventToCategory
//                       with force=true, then updates the message based on
//                       the outcome.
//   handleCancelPost  — cancel; item stays pending.

const { MessageFlags } = require('discord.js');

async function handleConfirmPost(bot, interaction) {
    if (!require('./admin').isAdmin(bot, interaction)) {
        return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
    }

    // Force is set by the `confirm_post_force:` customId prefix only. Normal
    // `confirm_post:` must respect dedup.
    const isForce = interaction.customId.startsWith('confirm_post_force:');

    const parts = interaction.customId.split(':');
    const [, mode, categoryKey, ...eventIdParts] = parts;
    const eventId = eventIdParts.join(':');

    const event = bot.cache.pendingEvents.find((e) => e.id === eventId);
    if (!event) {
        return interaction.update({ content: '❌ Item not found — may have already been posted or skipped.', components: [] });
    }

    await interaction.deferUpdate();
    // Honour the force flag from the customId: `confirm_post_force:` means
    // the human saw the "already posted" warning and chose to override. A
    // normal `confirm_post:` click must NOT bypass dedup — if another
    // instance raced and posted concurrently, this click should lose.
    const result = await bot.postEventToCategory(event, mode, categoryKey, isForce);

    if (result.ok) {
        if (mode === 'test') {
            const pe = bot.cache.pendingEvents.find((e) => e.id === event.id);
            if (pe) {
                pe.testPosted = true;
                pe.testPostedAt = Date.now();
                bot.saveCache();
            }
            let channelName = 'unknown';
            const channelId = bot.CATEGORIES[categoryKey] && bot.CATEGORIES[categoryKey].test;
            if (channelId) {
                try { const c = await bot.client.channels.fetch(channelId); channelName = (c && c.name) || 'unknown'; } catch (e) {}
            }
            return interaction.editReply({
                content: `✅ Test post of **"${event.title}"** to **${categoryKey}** — #${channelName} (TEST) successful.\nIt remains pending — use \`/pending\` and **Post to Live** when you're ready, or Skip to cancel.`,
                components: []
            });
        }

        bot.removeFromPending(event.id);
        bot.markEventPosted(event);
        bot.saveCache();
        let channelName = 'unknown';
        const channelId = bot.CATEGORIES[categoryKey] && bot.CATEGORIES[categoryKey].main;
        if (channelId) {
            try { const c = await bot.client.channels.fetch(channelId); channelName = (c && c.name) || 'unknown'; } catch (e) {}
        }
        return interaction.editReply({ content: `✅ Posted **"${event.title}"** to **${categoryKey}** — #${channelName} (LIVE).`, components: [] });
    }

    if (result.reason === 'no_image') {
        return interaction.editReply({ content: `❌ Not posted — **"${event.title}"** has no image, so it can't go to a LIVE channel. Use **Customize** to add an image URL, or post it to Test only.`, components: [] });
    }
    if (result.reason === 'already_posted' || result.reason === 'already_posted_or_racing') {
        const when = result.lastPostedAt;
        const whenText = when ? `<t:${Math.floor(when / 1000)}:R>` : 'moments ago';
        return interaction.editReply({ content: `🚫 Not posted — **"${event.title}"** was already sent to **${categoryKey}** ${whenText}. Nothing was sent this time.`, components: [] });
    }
    if (result.reason === 'in_progress') {
        return interaction.editReply({ content: `⏳ Not posted — a post for **"${event.title}"** to **${categoryKey}** is already in progress. Nothing extra was sent.`, components: [] });
    }
    if (result.reason === 'category_paused') {
        return interaction.editReply({ content: `⏸️ Not posted — category **${categoryKey}** is currently paused. Resume it before posting.`, components: [] });
    }

    return interaction.editReply({ content: `❌ Failed to post "${event.title}" to **${categoryKey}** (${result.reason}). Check the logs channel for details.`, components: [] });
}

async function handleCancelPost(bot, interaction) {
    const eventId = interaction.customId.split(':').slice(1).join(':');
    const event = bot.cache.pendingEvents.find((e) => e.id === eventId);
    await interaction.update({
        content: `❌ Cancelled — "${event ? event.title : 'this item'}" was not posted. It's still pending — use /pending to try again.`,
        components: []
    });
}

module.exports = { handleConfirmPost, handleCancelPost };
