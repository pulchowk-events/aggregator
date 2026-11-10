// src/core/formatting.js
// Message builders for Discord posts. Three renderers (event/job/
// scholarship), one length-guard shared by all three, all dispatch through
// buildPostContent() which picks the right one based on itemType.
//
// Every character of the output below is deliberate — 1:1 with the live
// bot. Changing a blank line or a bold marker changes how every historical
// post looks when re-rendered by /edit-live, so treat this file as a
// contract, not an implementation detail.

const { TITLE_EMOJIS, DESCRIPTION_EMOJIS, pickRandom, VERIFIED_BADGE } = require('../config/emojis');
const { MAX_TAGS_RENDERED, MAX_TAG_LENGTH, DISCORD_CONTENT_LIMIT, SAFETY_BUFFER, SAFETY_NOTE } = require('../config/constants');
const { sanitizeTagsForDisplay, hardTruncateDescription } = require('./normalize');
const { auditLog } = require('./auditLogger');

// Appended to job descriptions only. The SAFETY_NOTE toggle lives in
// constants.js — currently disabled by making this return the input
// unchanged. Turning it back on is a one-line edit here.
function appendSafetyNote(text) {
    const note = `\n\n*${SAFETY_NOTE}*`;
    if (!text) return note.trim();
    if (text.includes(`*${SAFETY_NOTE}*`)) return text;
    return text;   // SAFETY NOTE currently disabled — see header comment
}

// Shared length-guard: build the message with the full description first,
// and if it exceeds DISCORD_CONTENT_LIMIT, retry with the description
// truncated by exactly (overhead + SAFETY_BUFFER). If even that overflows
// (pathological case — huge tags list etc), hard-slice + ellipsis. Every
// branch is audited so we know if the guard ever really fires.
function buildLengthGuardedMessage({ item, build }) {
    let description = item.description || '';
    if (item.itemType === 'job') description = appendSafetyNote(description);

    let message = build(description);
    if (message.length <= DISCORD_CONTENT_LIMIT) return message;

    const overheadLength = build('').length;
    const allowedDescriptionLength = Math.max(0, DISCORD_CONTENT_LIMIT - SAFETY_BUFFER - overheadLength);
    const truncatedDescription = hardTruncateDescription(description, allowedDescriptionLength);

    auditLog('message_length_guard', `Message for "${item.title}" exceeded Discord's ${DISCORD_CONTENT_LIMIT}-char limit (${message.length} chars) — truncating description from ${description.length} to ${truncatedDescription.length} chars.`, {
        eventId: item.id || null, title: item.title || null, originalLength: message.length, allowedDescriptionLength
    }, 'warn');

    message = build(truncatedDescription);
    if (message.length > DISCORD_CONTENT_LIMIT) {
        message = message.slice(0, DISCORD_CONTENT_LIMIT - 3) + '...';
        auditLog('message_length_guard', `Message for "${item.title}" still exceeded the limit with an empty description — hard-truncated the whole message.`, {
            eventId: item.id || null, title: item.title || null
        }, 'error');
    }
    return message;
}

// ---------- Job ----------
function formatJobMessage(job, customPing = null) {
    const titleEmoji = pickRandom(TITLE_EMOJIS);
    const descriptionEmoji = pickRandom(DESCRIPTION_EMOJIS);
    const displaySkills = sanitizeTagsForDisplay(job.tags, MAX_TAGS_RENDERED, MAX_TAG_LENGTH);
    const skillsMore = (Array.isArray(job.tags) ? job.tags.length : 0) - displaySkills.length;

    const build = (description) => {
        let message = `## ${titleEmoji} ${job.title}\n** **\n`;
        if (customPing) message += `${customPing} ${VERIFIED_BADGE}\n\n`;
        if (job.company) message += `**${job.company}** ${descriptionEmoji}\n\n`;
        if (description) message += `${description}\n\n`;
        message += `**Job Details**\n\n`;
        if (job.location || job.employmentType) {
            message += `📍 **Location:** ${job.location || 'TBD'}`;
            if (job.employmentType) message += ` | 💼 ${job.employmentType}`;
            message += '\n';
        }
        if (job.attendanceMode) message += `🏠 **Work Mode:** ${job.attendanceMode}\n`;
        if (job.salary) message += `💰 **Salary:** ${job.salary}\n`;
        if (job.experience) message += `📈 **Experience:** ${job.experience}\n`;
        if (job.level) message += `🎯 **Level:** ${job.level}\n`;
        if (job.openings) message += `👥 **Openings:** ${job.openings}\n`;
        if (job.applicationEndsRaw) message += `⏳ **Apply by:** ${job.applicationEndsRaw}\n`;
        if (job.registrationUrl || job.url) {
            const link = job.registrationUrl || job.url;
            message += `\n**Apply Here:** [Click here](<${link}>)\n`;
        }
        if (displaySkills.length > 0) {
            message += `\n🏷️ **Skills:** ${displaySkills.join(', ')}${skillsMore > 0 ? ` (+${skillsMore} more)` : ''}\n`;
        }
        message += `** **`;
        return message;
    };

    return buildLengthGuardedMessage({ item: job, build });
}

// ---------- Scholarship ----------
// No appendSafetyNote() here — that warning ("secure a written contract...")
// is job-specific and doesn't apply to scholarships.
function formatScholarshipMessage(scholarship, customPing = null) {
    const titleEmoji = pickRandom(TITLE_EMOJIS);
    const descriptionEmoji = pickRandom(DESCRIPTION_EMOJIS);
    const displayTags = sanitizeTagsForDisplay(scholarship.tags, MAX_TAGS_RENDERED, MAX_TAG_LENGTH);
    const tagsMore = (Array.isArray(scholarship.tags) ? scholarship.tags.length : 0) - displayTags.length;

    const build = (description) => {
        let message = `## ${titleEmoji} ${scholarship.title}\n** **\n`;
        if (customPing) message += `${customPing} ${VERIFIED_BADGE}\n\n`;
        if (scholarship.organizer) message += `**${scholarship.organizer}** ${descriptionEmoji}\n\n`;
        if (description) message += `${description}\n\n`;
        message += `**Scholarship Details**\n\n`;
        if (scholarship.deadlineDisplay) {
            const label = scholarship.deadlineStatus === 'estimated-year-only' ? 'For Year' : 'Deadline';
            message += `🗓️ **${label}:** ${scholarship.deadlineDisplay}\n`;
        }
        if (scholarship.degreeLevel) message += `🎓 **Degree Level:** ${scholarship.degreeLevel}\n`;
        if (scholarship.fieldOfStudy) message += `📚 **Field of Study:** ${scholarship.fieldOfStudy}\n`;
        if (scholarship.price) message += `💰 **Funding:** ${scholarship.price}\n`;
        if (scholarship.registrationUrl || scholarship.url) {
            const link = scholarship.registrationUrl || scholarship.url;
            message += `\n**More Info / Apply:** [Click here](<${link}>)\n`;
        }
        if (displayTags.length > 0) {
            message += `\n🏷️ **Tags:** ${displayTags.join(', ')}${tagsMore > 0 ? ` (+${tagsMore} more)` : ''}\n`;
        }
        message += `** **`;
        return message;
    };

    return buildLengthGuardedMessage({ item: scholarship, build });
}

// ---------- Event ----------
function formatEventBody(event, customPing = null) {
    const titleEmoji = pickRandom(TITLE_EMOJIS);
    const descriptionEmoji = pickRandom(DESCRIPTION_EMOJIS);
    const displayTags = sanitizeTagsForDisplay(event.tags, MAX_TAGS_RENDERED, MAX_TAG_LENGTH);
    const tagsMore = (Array.isArray(event.tags) ? event.tags.length : 0) - displayTags.length;

    const build = (description) => {
        let message = `## ${titleEmoji} ${event.title}\n** **\n`;
        if (customPing) message += `${customPing} ${VERIFIED_BADGE}\n\n`;
        if (description) message += `${description} ${descriptionEmoji}\n\n`;
        message += `**Event Details**\n\n`;
        if (event.date) {
            message += `🗓️ **Time:** ${event.date}`;
            if (event.time) message += ` | 🕢 ${event.time}`;
            message += '\n';
        }
        if (event.location) message += `📍 **Location:** ${event.location}\n`;
        if (event.price && event.price !== 'TBD') message += `💰 **Price:** ${event.price}\n`;
        if (event.category && event.category !== 'General') message += `🏷️ **Category:** ${event.category}\n`;
        if (event.attendanceMode) message += `👥 **Mode:** ${event.attendanceMode}\n`;
        if (event.registrationUrl || event.url) {
            const link = event.registrationUrl || event.url;
            message += `\n**Register Here:** [Click here](<${link}>)\n`;
        }
        if (displayTags.length > 0) {
            message += `\n🏷️ **Tags:** ${displayTags.join(', ')}${tagsMore > 0 ? ` (+${tagsMore} more)` : ''}\n`;
        }
        message += `** **`;
        return message;
    };

    return buildLengthGuardedMessage({ item: event, build });
}

// ---------- Dispatch ----------
function buildPostContent(item, customPing = null) {
    if (item.itemType === 'job') return formatJobMessage(item, customPing);
    if (item.itemType === 'scholarship') return formatScholarshipMessage(item, customPing);
    return formatEventBody(item, customPing);
}

module.exports = {
    buildPostContent,
    formatEventMessage: formatEventBody,
    formatJobMessage,
    formatScholarshipMessage,
    appendSafetyNote
};
