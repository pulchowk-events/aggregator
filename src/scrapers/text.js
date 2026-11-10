// src/scrapers/text.js
// Text cleaning helpers shared across scrapers.
//
// All three original scrapers (events, jobs, scholarships) had slightly
// different copies of the same three operations. This consolidates them.
// Pure functions — no page, no browser, no filesystem.

// Strip the markdown hard-line-break backslashes that leak through when we
// pull `.textContent` / JSON-LD description instead of rendering the source
// markdown. A backslash followed by whitespace/newline/end-of-string is
// Markdown's "line break" syntax, never a real escape — real escapes look
// like \* \_ \[ (backslash immediately followed by a non-space). Safe to
// drop those. Then collapse leftover whitespace.
function cleanDescriptionText(text) {
    if (!text) return text;
    return text
        .replace(/\\+(?=\s|$)/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Trim `description` to fit under `maxLength`, preferring to end on a
// sentence boundary. Same logic as the message length guard — kept here
// too because scrapers often want this BEFORE the item hits the cache.
function trimDescriptionToLastSentence(description, maxLength = 1500) {
    const cleaned = cleanDescriptionText(description);
    if (!cleaned || cleaned.length <= maxLength) return cleaned;
    let trimmed = cleaned.substring(0, maxLength);
    const lastPeriod = trimmed.lastIndexOf('.');
    return lastPeriod > maxLength * 0.5 ? trimmed.substring(0, lastPeriod + 1) : trimmed.trim() + '…';
}

// NepVents-specific description cleaner. The site embeds the entire event
// page (including detail-table rows, social links, a "Register Here"
// button) inside the description field, with each block separated by
// newlines. We want the actual paragraph(s) up to the first "event details"
// style marker — everything after is boilerplate.
//
// Fallback (if no marker hits): first 2 paragraphs.
//
// Why this lives here instead of in nepvents.js: the marker list is
// long and worth its own file to make the scraping plugin small and
// obvious. If you add another source with the same "wall of text" problem,
// this is the function to reach for.
function cleanNepVentsDescription(raw) {
    if (!raw) return '';

    let text = raw
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    const stopMarkers = [
        /event details/i,
        /about the speaker/i,
        /why attend/i,
        /contact us/i,
        /socials/i,
        /register here/i,
        /platform:/i,
        /date:/i,
        /time:/i,
        /location:/i,
        /organizer:/i,
        /price:/i,
        /category:/i,
        /mode:/i,
        /tags:/i,
        /^\s*---\s*$/,
        /^\s*###\s*/,
        /^\s*📅\s*/,
        /^\s*🕒\s*/,
        /^\s*💻\s*/,
        /^\s*🔗\s*/,
        /^\s*📧\s*/,
        /^\s*📘\s*/,
        /^\s*💼\s*/,
        /^\s*📷\s*/,
        /^\s*🏷️\s*/
    ];

    let cutIndex = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (stopMarkers.some((re) => re.test(lines[i]))) {
            cutIndex = i;
            break;
        }
    }

    let cleaned = lines.slice(0, cutIndex).join('\n').trim();
    if (!cleaned) {
        const paragraphs = raw.split(/\n\s*\n/);
        cleaned = paragraphs.slice(0, 2).join('\n\n').trim();
    }
    return cleaned;
}

module.exports = {
    cleanDescriptionText,
    trimDescriptionToLastSentence,
    cleanNepVentsDescription
};
