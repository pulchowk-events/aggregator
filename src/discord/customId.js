// src/discord/customId.js
// Button + modal customId encode/decode.
//
// Format: <action>:<eventId>. Event ids may themselves contain ':' — that's
// why decode uses indexOf, not split(':'), so the full eventId survives.
// Category-picker select menus and confirm buttons extend the prefix:
// <action>:<mode>:<categoryKey>:<eventId>.

const SEPARATOR = ':';

function buildCustomId(action, eventId) {
    return `${action}${SEPARATOR}${eventId}`;
}

function parseCustomId(customId) {
    const sepIndex = customId.indexOf(SEPARATOR);
    if (sepIndex === -1) return { action: customId, eventId: null };
    return { action: customId.slice(0, sepIndex), eventId: customId.slice(sepIndex + 1) };
}

module.exports = { SEPARATOR, buildCustomId, parseCustomId };
