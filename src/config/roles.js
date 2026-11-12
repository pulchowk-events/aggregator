// src/config/roles.js
// Role IDs used for live-post pings, centralised.
//
// Every hardcoded value here is SERVER-SPECIFIC — it only resolves in the
// guild that owns those roles. Forkers must replace these with their own
// server's role IDs (right-click role in Discord -> Copy ID with Developer
// Mode on) to make pings land on their roles instead of the original
// server's.
//
// Two entries (jobs, scholarships) are ALSO read from .env if set. The
// env var wins when present — that's the established behaviour from the
// original bot, kept intact so no existing deployment has to re-edit
// anything. Everything else is env-free by design so switching servers is
// a one-file edit.

const path = require('path');
const dotenv = require('dotenv');

// Reuse the same .env discovery as config/env.js so both files always see
// the same values, regardless of require order.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function envOrNull(name) {
    const v = process.env[name];
    return v === undefined || v === '' ? null : v;
}

// ---------- Hardcoded role IDs (server-specific, edit on fork) ----------
const HARDCODED = {
    sports:        '1124916543864713322',
    software:      '1124986979868745815',
    hardware:      '1124986137031753758',
    gaming:        '1124985995960533015',
    music:         '1125055841834373292',
    business:      '1125056110894792754',
    miscellaneous: '1388075747679145994'
};

// ---------- Env-overridable entries ----------
// null means "ping nothing for this category" — the formatted post just
// omits the role mention, which is the existing behaviour when the env var
// isn't set. See shouldPingForEvent() in core/formatting.
const FROM_ENV = {
    jobs:         envOrNull('JOBS_PING_ROLE_ID'),
    scholarships: envOrNull('SCHOLARSHIPS_PING_ROLE_ID')
};

// ---------- Public: role ID per category ----------
// Returns the raw role snowflake (as a string) or null. Callers format it
// as `<@&id>` themselves — keeping the raw ID here means a forker only
// ever edits ONE file when porting to a new server.
const PING_ROLE_IDS = { ...HARDCODED, ...FROM_ENV };

// Accept raw snowflakes only. If a value arrives already wrapped as a
// mention (<@&123...>, <@123...>, or with quotes), unwrap it. This makes
// the module resilient to a common .env paste mistake: pasting the full
// mention instead of just the ID. Without this normalization, a wrapped
// value ends up double-wrapped in getPingMention, producing
// "<@&<@&123...>>" which Discord renders as literal text.
function normalizeRoleId(raw) {
    if (!raw) return null;
    let v = String(raw).trim();
    // Strip surrounding quotes
    v = v.replace(/^["']|["']$/g, '');
    // Strip Discord mention wrapper: <@&123>, <@123>, <@!123>
    const mentionMatch = v.match(/^<@&?!?(\d+)>$/);
    if (mentionMatch) v = mentionMatch[1];
    // Whatever is left must be digits — otherwise treat as invalid
    if (!/^\d{17,19}$/.test(v)) return null;
    return v;
}

function getPingRoleId(categoryKey) {
    return normalizeRoleId(PING_ROLE_IDS[categoryKey]);
}

// Convenience for formatting code that needs the Discord mention syntax.
function getPingMention(categoryKey) {
    const id = getPingRoleId(categoryKey);
    return id ? `<@&${id}>` : null;
}

module.exports = {
    PING_ROLE_IDS,
    normalizeRoleId,
    getPingRoleId,
    getPingMention
};
