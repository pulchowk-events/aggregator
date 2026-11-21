// src/discord/sendPendingEventsMessage.js
// Renders the /pending list — one EmbedBuilder + one ActionRow per item,
// with the four review buttons (post_live, post_test, customize, skip).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { auditLog } = require('../core/auditLogger');
const { isEventPast, compareByEventDate } = require('../core/dateUtils');
const { deduplicateEventsByKey } = require('../posting/dedup');
const { hasSufficientData, canAttachPlaceholder } = require('../posting/gates');
const { renderPlaceholderPng, placeholderLabelFor } = require('../scrapers/placeholderRender');

const EMBED_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValueTarget: 1000 };

function clampText(value, max) {
    const s = String(value ?? '');
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '\u2026';
}

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
    let description = clampText(event.description || 'No description', 3000);

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
    const usePlaceholder = canAttachPlaceholder(event);
    const dataSufficient = hasSufficientData(event);
    if (usePlaceholder && !event.image) {
        description += '\n\n\u{1F5BC}\u{FE0F} **No image** - a branded placeholder is generated and attached when this is posted.';
    }
    if (!dataSufficient) {
        description += '\n\n\u26D4 **Insufficient data** - a job needs at least one of: apply-by date, a short location (under 50 chars), or a salary figure (under 30 chars). It cannot go to a LIVE or TEST channel until one is added (Customize).';
    }
    if (!eventHasImage) {
        description += '\n\n🖼️ **No image** - this can never go to a LIVE channel until one is added. Use Customize to add an image URL, or it will stay Test-only.';
    }
    if (event.locationReview) {
        const loc = event.location ? '`' + String(event.location).slice(0, 80) + '`' : 'empty';
        const why = event.locationReview === 'unknown'
            ? 'filter could not classify'
            : (event.locationReview === 'geo-error' ? 'classifier error' : 'location was empty');
        description += `\n\n\u{1F30D} **Location review** - ${why} (${loc}). Verify this is Nepal-relevant before posting live.`;
    }
    if (event.imageSource === 'placeholder') {
        description += '\n\n\u{1F5BC}\u{FE0F} **Placeholder image** - source site exposed no og:image or favicon; using generated brand PNG. Use Customize to override with a real logo.';
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

    const safeFields = fields.map((f) => ({
        name: clampText(f.name, EMBED_LIMITS.fieldName),
        value: clampText(f.value, EMBED_LIMITS.fieldValueTarget) || 'TBD',
        inline: f.inline
    }));
    const safeDescription = clampText(description, isEventPast(event) ? 4000 : EMBED_LIMITS.description);

    const embed = new EmbedBuilder()
        .setTitle(clampText(event.title || 'Untitled', EMBED_LIMITS.title))
        .setDescription(safeDescription)
        .addFields(...safeFields)
        .setColor((bot.hasDataQualityWarnings(event) || bot.isEventTooSoon(event) || !eventHasImage || !dataSufficient) ? 0xE67E22 : 0x00AE86)
        .setFooter({ text: `Source: ${source}  •  ID: ${event.id}` });

    const files = [];
    if (usePlaceholder) {
        try {
            files.push(new AttachmentBuilder(renderPlaceholderPng(placeholderLabelFor(event)), { name: 'placeholder.png' }));
            embed.setImage('attachment://placeholder.png');
        } catch (renderError) {
            console.warn('Placeholder render failed for pending preview:', renderError.message);
        }
    } else if (bot.hasValidImage(event)) {
        embed.setImage(event.image);
    }
    if (isEventPast(event)) embed.setDescription(embed.data.description + '\n\n⚠️ **This item appears to be in the past.**');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`post_live:${event.id}`).setLabel('Post to Live').setStyle(ButtonStyle.Success).setDisabled(!eventHasImage || !dataSufficient),
        new ButtonBuilder().setCustomId(`post_test:${event.id}`).setLabel('Post to Test').setStyle(ButtonStyle.Primary).setDisabled(!dataSufficient),
        new ButtonBuilder().setCustomId(`customize:${event.id}`).setLabel('Customize').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`skip:${event.id}`).setLabel('Skip').setStyle(ButtonStyle.Danger)
    );

    try {
        await channel.send({ embeds: [embed], components: [row], files });
    } catch (error) {
        console.error(`❌ Failed to send pending-event message for "${event.title}":`, error);
        auditLog('discord_api_error', `channel.send() failed for "${event.title}"`, {
            eventId: event.id || null, title: event.title || null,
            errorMessage: error.message, errorCode: error.code || null
        }, 'error');
    }
}

module.exports = { sendPendingEventsMessage, sendOnePendingEmbed };
