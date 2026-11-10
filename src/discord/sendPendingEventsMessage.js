// src/discord/sendPendingEventsMessage.js
// Renders the /pending list — one EmbedBuilder + one ActionRow per item,
// with the four review buttons (post_live, post_test, customize, skip).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { auditLog } = require('../core/auditLogger');
const { isEventPast, compareByEventDate } = require('../core/dateUtils');
const { deduplicateEventsByKey } = require('../posting/dedup');

async function sendPendingEventsMessage(bot, channel, eventsToShow = null) {
    const events = eventsToShow || bot.cache.pendingEvents;
    const futureEvents = events.filter((e) => !isEventPast(e));
    const uniqueFuture = deduplicateEventsByKey(futureEvents);
    uniqueFuture.sort((a, b) => compareByEventDate(a, b));

    if (uniqueFuture.length === 0) {
        await channel.send('✅ No pending items (upcoming).');
        return;
    }

    let anyChanged = false;
    for (const event of uniqueFuture) {
        const before = JSON.stringify(event.dataQualityWarnings || []);
        bot.sanitizeEventFields(event);
        const after = JSON.stringify(event.dataQualityWarnings || []);
        if (before !== after) anyChanged = true;
    }
    if (anyChanged) bot.saveCache();

    for (const event of uniqueFuture) {
        await sendOnePendingEmbed(bot, channel, event);
    }
}

async function sendOnePendingEmbed(bot, channel, event) {
    const source = event.source || 'unknown';
    let description = event.description || 'No description';

    if (event.testPosted) {
        description += '\n\n✅ **Test-posted** - use **Post to Live** below when you are ready.';
    }
    if (bot.hasDataQualityWarnings(event)) {
        description += `\n\n⚠️ **Data quality warning(s):**\n${event.dataQualityWarnings.map((w) => `• ${w}`).join('\n')}`;
    }
    if (bot.isEventTooSoon(event)) {
        description += `\n\n⏳ **Less than ${bot.getAutopostMinLeadDays()} day(s) away** - registration is likely closing/closed. Autopost will skip this; post manually only if you are sure it is still valid.`;
    }
    const eventHasImage = bot.hasValidImage(event);
    if (!eventHasImage) {
        description += '\n\n🖼️ **No image** - this can never go to a LIVE channel until one is added. Use Customize to add an image URL, or it will stay Test-only.';
    }
    if (bot.isStuckNeedsAttentionEvent(event) && event.firstSeenAt) {
        const archiveAtMs = event.firstSeenAt + (bot.getNeedsAttentionExpiryDays() * 24 * 60 * 60 * 1000);
        description += `\n\n🗄️ If this is not fixed, it will be auto-archived <t:${Math.floor(archiveAtMs / 1000)}:R> (never auto-posted live).`;
    }

    const fields = [];
    if (event.itemType === 'job') {
        fields.push({ name: 'Apply By', value: event.date || 'TBD', inline: true });
        fields.push({ name: 'Location', value: event.location || 'TBD', inline: true });
        fields.push({ name: 'Salary', value: event.price || 'TBD', inline: true });
    } else if (event.itemType === 'scholarship') {
        if (event.deadlineDisplay) {
            fields.push({ name: event.deadlineStatus === 'estimated-year-only' ? 'For Year' : 'Deadline', value: event.deadlineDisplay, inline: true });
        }
        fields.push({ name: 'Provider', value: event.organizer || 'TBD', inline: true });
        fields.push({ name: 'Funding', value: event.price || 'TBD', inline: true });
    } else {
        fields.push({ name: 'Date', value: event.date || 'TBD', inline: true });
        fields.push({ name: 'Location', value: event.location || 'TBD', inline: true });
        fields.push({ name: 'Price', value: event.price || 'TBD', inline: true });
    }

    const embed = new EmbedBuilder()
        .setTitle(event.title || 'Untitled')
        .setDescription(description)
        .addFields(...fields)
        .setColor((bot.hasDataQualityWarnings(event) || bot.isEventTooSoon(event) || !eventHasImage) ? 0xE67E22 : 0x00AE86)
        .setFooter({ text: `Source: ${source}  •  ID: ${event.id}` });

    if (bot.hasValidImage(event)) embed.setImage(event.image);
    if (isEventPast(event)) embed.setDescription(embed.data.description + '\n\n⚠️ **This item appears to be in the past.**');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`post_live:${event.id}`).setLabel('Post to Live').setStyle(ButtonStyle.Success).setDisabled(!eventHasImage),
        new ButtonBuilder().setCustomId(`post_test:${event.id}`).setLabel('Post to Test').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`customize:${event.id}`).setLabel('Customize').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`skip:${event.id}`).setLabel('Skip').setStyle(ButtonStyle.Danger)
    );

    try {
        await channel.send({ embeds: [embed], components: [row] });
    } catch (error) {
        console.error(`❌ Failed to send pending-event message for "${event.title}":`, error);
        auditLog('discord_api_error', `channel.send() failed for "${event.title}"`, {
            eventId: event.id || null, title: event.title || null,
            errorMessage: error.message, errorCode: error.code || null
        }, 'error');
    }
}

module.exports = { sendPendingEventsMessage };
