// src/core/auditLogger.js
// Shared audit-trail choke point. Every decision the bot makes — no matter
// which module it lives in — writes through this one function so the
// record is consistent and complete.
//
// Every auditLog() call does two things, IN THIS ORDER:
//   1. Append a line to data/audit-log.jsonl. This happens FIRST and
//      unconditionally — it does not depend on Discord, the bot being
//      logged in, or the audit channel being configured. A Discord outage
//      can never mean zero record exists.
//   2. Best-effort attempt to also post the same entry to the dedicated
//      Discord audit channel (registered via registerDiscordAuditChannel
//      once the bot logs in, or auto-derived from AUDIT_LOG_CHANNEL_ID in
//      config/env.js). Fire-and-forget — a failure here only logs a console
//      warning, it never re-throws or blocks.
//
// Deliberately a plain module-level singleton (not a class) so scraper
// modules — which have no access to the bot's Discord client — can require()
// it directly and start writing to the local file immediately.

const fs = require('fs');
const path = require('path');

// Runtime state lives under ./data/ at repo root. Config, code, and this
// runtime state stay separated so a forker never has to gitignore a data
// file they accidentally created next to the source.
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit-log.jsonl');

// Rotation: cap the local file so it can't grow unbounded (mirrors the same
// pattern already used for cache.expiredEvents, capped at CACHE_CAP). We cap
// by line count AND byte size — whichever notices first — and simply keep
// the most recent MAX_LINES entries.
const MAX_AUDIT_LINES = 5000;
const MAX_AUDIT_BYTES = 5 * 1024 * 1024; // 5 MB

// Discord message bodies are capped at 2000 chars; keep the embedded JSON
// well under that so the header/footer always fit too.
const DISCORD_BODY_CHAR_LIMIT = 1500;

let discordClient = null;
let auditChannelId = null;

// Lazily read the env-configured channel ID at first use, so requiring this
// module from a scraper (which runs in the same process as bot.js) picks up
// the right value without an explicit register call in that path. bot.js
// still calls registerDiscordAuditChannel() explicitly once ready — that
// call takes precedence if it supplies a non-null channelId.
function defaultAuditChannelId() {
    try {
        return require('../config/env').AUDIT_LOG_CHANNEL_ID || null;
    } catch (e) {
        return null;
    }
}

// Called once from the bot after login. Safe to call again later.
function registerDiscordAuditChannel(client, channelId) {
    discordClient = client || null;
    auditChannelId = channelId || null;
}

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        console.error('❌ Failed to create data directory for audit log:', e);
    }
}

function rotateIfNeeded() {
    try {
        if (!fs.existsSync(AUDIT_LOG_FILE)) return;
        const stat = fs.statSync(AUDIT_LOG_FILE);
        if (stat.size <= MAX_AUDIT_BYTES) return;

        const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length <= MAX_AUDIT_LINES) return;

        const trimmed = lines.slice(-MAX_AUDIT_LINES);
        fs.writeFileSync(AUDIT_LOG_FILE, trimmed.join('\n') + '\n');
    } catch (error) {
        console.error('❌ Failed to rotate local audit log:', error);
    }
}

function writeLocal(entry) {
    try {
        ensureDataDir();
        rotateIfNeeded();
        fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (error) {
        // The local file is supposed to be the one thing that can never
        // silently fail — if even this throws, surface it loudly.
        console.error('❌ Failed to write local audit-log.jsonl entry:', error, entry);
    }
}

function safeStringify(data) {
    try {
        return JSON.stringify(data, null, 2);
    } catch (error) {
        try {
            // data may contain circular refs (e.g. raw Discord.js error
            // objects) — fall back to a shallow, safe representation.
            return JSON.stringify({ unstringifiable: true, note: String(error.message) });
        } catch (e2) {
            return '"<unstringifiable audit data>"';
        }
    }
}

async function postToDiscord(entry) {
    const channelId = auditChannelId || defaultAuditChannelId();
    if (!discordClient || !channelId) return;
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const header = `\`[${entry.level.toUpperCase()}]\` **${entry.category}** — ${entry.message}`;
        let body = safeStringify(entry.data ?? {});
        let truncatedNote = '';
        if (body.length > DISCORD_BODY_CHAR_LIMIT) {
            body = body.slice(0, DISCORD_BODY_CHAR_LIMIT);
            truncatedNote = '\n…(truncated — full entry is in local audit-log.jsonl)';
        }
        const content = `${header}\n\`\`\`json\n${body}\n\`\`\`${truncatedNote}`;

        await channel.send({ content: content.slice(0, 2000) });
    } catch (error) {
        // Best-effort only. Never throw back into the caller — the local
        // file write above already guaranteed the entry exists somewhere.
        console.error('❌ Failed to post audit entry to Discord audit channel:',
            error && error.stack ? error.stack : error);
    }
}

// category: short machine-readable label (e.g. 'sanitize_event',
//           'dedup_decision', 'posted_marker', 'determine_category',
//           'autopost_filter', 'post_result', 'discord_api_error')
// message:  short human-readable one-liner
// data:     full structured payload — event objects, ids, filter values, errors
// level:    'info' | 'warn' | 'error'
function auditLog(category, message, data = {}, level = 'info') {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        category,
        message,
        data
    };

    // 1. Local file — always, first, independent of Discord entirely.
    writeLocal(entry);

    // 2. Discord post — best-effort, fire-and-forget, never blocks/throws.
    postToDiscord(entry).catch(() => { /* already logged inside postToDiscord */ });

    return entry;
}

module.exports = {
    auditLog,
    registerDiscordAuditChannel,
    AUDIT_LOG_FILE,
    DATA_DIR
};
