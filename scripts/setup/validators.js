// scripts/setup/validators.js
// Pure validators for setup-wizard inputs. Each returns either { ok: true }
// or { ok: false, reason: '...' }. No side effects, no I/O.

// Discord bot tokens: three dot-separated segments. First segment is base64
// (encodes bot user id + creation time), second is base64, third is HMAC.
// We don't verify the HMAC (that requires the secret) — this just catches
// obvious paste errors: missing segments, whitespace, quotes.
function validateDiscordToken(token) {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'Token is empty.' };
    const trimmed = token.trim();
    if (/[\s"']/.test(trimmed)) return { ok: false, reason: 'Token contains whitespace or quotes — paste the raw value.' };
    const parts = trimmed.split('.');
    if (parts.length !== 3) return { ok: false, reason: `Token has ${parts.length} segments (expected 3, dot-separated).` };
    if (parts.some((p) => p.length < 10)) return { ok: false, reason: 'One of the token segments is too short — check the paste.' };
    return { ok: true };
}

// Discord snowflakes: 17-19 decimal digits. Modern IDs are 19 digits.
function validateSnowflake(id) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'ID is empty.' };
    const trimmed = String(id).trim().replace(/^["']|["']$/g, '');
    if (!/^\d{17,19}$/.test(trimmed)) return { ok: false, reason: `"${trimmed}" is not a Discord snowflake (expected 17-19 digits).` };
    return { ok: true, normalized: trimmed };
}

// Supabase project URLs: https://<ref>.supabase.co
// Sometimes users paste the API URL like https://<ref>.supabase.co/rest/v1 — trim.
function validateSupabaseUrl(url) {
    if (!url || typeof url !== 'string') return { ok: false, reason: 'URL is empty.' };
    const trimmed = url.trim().replace(/^["']|["']$/g, '');
    try {
        const u = new URL(trimmed);
        if (u.protocol !== 'https:') return { ok: false, reason: 'URL must be https://.' };
        if (!/\.supabase\.(co|in)$/.test(u.hostname)) return { ok: false, reason: `Hostname "${u.hostname}" is not a Supabase project URL (expected *.supabase.co).` };
        // Normalize: keep only scheme + host
        return { ok: true, normalized: `https://${u.hostname}` };
    } catch (e) {
        return { ok: false, reason: `Not a parseable URL: ${trimmed}` };
    }
}

// Supabase keys are JWTs — start with "eyJ" (base64 of '{"' ). Service role
// keys are longer than anon keys; but we don't need to enforce that here,
// Supabase will reject the wrong one at query time.
function validateSupabaseKey(key, { allowAnon = true } = {}) {
    if (!key || typeof key !== 'string') return { ok: false, reason: 'Key is empty.' };
    const trimmed = key.trim().replace(/^["']|["']$/g, '');
    if (!trimmed.startsWith('eyJ')) return { ok: false, reason: 'Key does not look like a Supabase JWT (should start with "eyJ").' };
    if (trimmed.length < 100) return { ok: false, reason: 'Key looks truncated (expected at least 100 chars).' };
    return { ok: true, normalized: trimmed };
}

// Generic http(s) URL.
function validateUrl(url) {
    if (!url || typeof url !== 'string') return { ok: false, reason: 'URL is empty.' };
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'URL must be http(s).' };
        return { ok: true, normalized: u.toString() };
    } catch (e) {
        return { ok: false, reason: `Not a parseable URL: ${url}` };
    }
}

// 5-field cron. Uses node-cron's validator when available, else falls back
// to a simple field-count check.
function validateCron(expr) {
    if (!expr || typeof expr !== 'string') return { ok: false, reason: 'Cron expression is empty.' };
    const trimmed = expr.trim();
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) return { ok: false, reason: `Expected 5 fields, got ${fields.length}.` };
    try {
        const cron = require('node-cron');
        if (!cron.validate(trimmed)) return { ok: false, reason: 'node-cron rejected this expression.' };
    } catch (e) { /* node-cron not present — accept on field count */ }
    return { ok: true, normalized: trimmed };
}

// Channel/role name validation for creation. Discord rules: 1-100 chars,
// lowercase preferred for channels, no spaces in channels (auto-replace
// with '-'), emoji allowed.
function validateChannelName(name) {
    if (!name || typeof name !== 'string') return { ok: false, reason: 'Name is empty.' };
    const trimmed = name.trim();
    if (trimmed.length < 1) return { ok: false, reason: 'Name is empty.' };
    if (trimmed.length > 100) return { ok: false, reason: 'Name is over 100 chars.' };
    // Discord will auto-lowercase and replace spaces — warn if user's input
    // isn't in canonical form, but don't reject.
    const canonical = trimmed.toLowerCase().replace(/\s+/g, '-');
    return { ok: true, normalized: canonical };
}

function validateRoleName(name) {
    if (!name || typeof name !== 'string') return { ok: false, reason: 'Name is empty.' };
    const trimmed = name.trim();
    if (trimmed.length < 1) return { ok: false, reason: 'Name is empty.' };
    if (trimmed.length > 100) return { ok: false, reason: 'Name is over 100 chars.' };
    return { ok: true, normalized: trimmed };
}

module.exports = {
    validateDiscordToken, validateSnowflake,
    validateSupabaseUrl, validateSupabaseKey,
    validateUrl, validateCron,
    validateChannelName, validateRoleName
};
