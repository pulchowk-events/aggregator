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
// Allow tests / tools to redirect audit writes away from data/audit-log.jsonl
// by setting AUDIT_FILE to an alternate path. Production never sets this, so
// behavior is unchanged unless explicitly opted in.
const DEFAULT_AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit-log.jsonl');
const AUDIT_LOG_FILE = process.env.AUDIT_FILE
    ? path.resolve(process.env.AUDIT_FILE)
    : DEFAULT_AUDIT_LOG_FILE;

// Bug 7: a stray AUDIT_FILE export silently redirects every audit write away
// from the default file. Warn ONCE at load (informational, not fatal).
if (process.env.AUDIT_FILE) {
    console.warn(`[auditLogger] AUDIT_FILE is set: audit entries are written to ${AUDIT_LOG_FILE} instead of the default ${DEFAULT_AUDIT_LOG_FILE}. Unset AUDIT_FILE to restore the default.`);
}

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
        const target = path.dirname(AUDIT_LOG_FILE);
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
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
        // Drop oldest lines until BOTH constraints are satisfied.
        // Line-count-only trim is insufficient when recent entries are
        // large (sanitize_scraped_event embeds the full event object --
        // ~1KB per line). 5000 lines of fat entries can exceed the 5MB
        // byte cap on their own, so the file oscillated at 5001 lines /
        // ~5.6MB forever, never under 5MB.
        let start = 0;
        let bytes = stat.size;
        while (start < lines.length && (lines.length - start) > MAX_AUDIT_LINES) {
            bytes -= Buffer.byteLength(lines[start], 'utf8') + 1;
            start++;
        }
        while (start < lines.length && bytes > MAX_AUDIT_BYTES) {
            bytes -= Buffer.byteLength(lines[start], 'utf8') + 1;
            start++;
        }

        if (start === 0) return;
        const trimmed = lines.slice(start);
        fs.writeFileSync(AUDIT_LOG_FILE, trimmed.join('\n') + '\n');
    } catch (error) {
        console.error('❌ Failed to rotate local audit log:', error);
    }
}

// --- Serialization for the local JSONL line (bug 5) ---
// Tier 1: plain compact stringify (identical output for every healthy entry).
// Tier 2: cycle-safe replacer. Errors become plain objects, BigInt becomes a
//         string, circular refs become '[Circular]'. Preserves errorRaw.
// Tier 3: degraded envelope (timestamp/level/category/message + failure note)
//         when even tier 2 throws (e.g. a throwing getter). A line is always
//         produced; fs errors are NOT handled here and still reach writeLocal.
function errorToPlain(e) {
    const out = { name: e.name, message: e.message, stack: e.stack };
    for (const k of Object.keys(e)) {
        try { out[k] = e[k]; } catch (err) { out[k] = '[Unreadable: ' + (err && err.message) + ']'; }
    }
    try { if (e.cause !== undefined && out.cause === undefined) out.cause = e.cause; } catch (err) { /* ignore */ }
    return out;
}

function makeCycleSafeReplacer() {
    const ancestors = []; // { orig, ret }
    return function (key, value) {
        if (typeof value === 'bigint') return value.toString();
        if (value === null || typeof value !== 'object') return value;
        while (ancestors.length && ancestors[ancestors.length - 1].ret !== this) ancestors.pop();
        if (ancestors.some((a) => a.orig === value)) return '[Circular]';
        const ret = value instanceof Error ? errorToPlain(value) : value;
        ancestors.push({ orig: value, ret });
        return ret;
    };
}

function serializeEntry(entry) {
    try {
        return JSON.stringify(entry);
    } catch (firstError) {
        try {
            const line = JSON.stringify(entry, makeCycleSafeReplacer());
            console.warn('\u26a0\ufe0f audit entry needed cycle-safe serialization (' + entry.category + '): ' + firstError.message);
            return line;
        } catch (secondError) {
            console.warn('\u26a0\ufe0f audit entry degraded to envelope-only (' + entry.category + '): ' + secondError.message);
            try {
                return JSON.stringify({
                    timestamp: entry.timestamp,
                    level: entry.level,
                    category: entry.category,
                    message: entry.message,
                    serializationFailed: true,
                    serializationError: String(secondError && secondError.message)
                });
            } catch (thirdError) {
                return '{"serializationFailed":true,"serializationError":"envelope unserializable"}';
            }
        }
    }
}

function writeLocal(entry) {
    try {
        ensureDataDir();
        rotateIfNeeded();
        fs.appendFileSync(AUDIT_LOG_FILE, serializeEntry(entry) + '\n');
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
