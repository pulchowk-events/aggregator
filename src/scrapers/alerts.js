// src/scrapers/alerts.js
// Time-sensitive source-failure alerts.
//
// Distinct from the audit log: audit-log.jsonl is the exhaustive forensic
// record (every decision, every scrape, every event). Alerts are the "hey,
// something is wrong RIGHT NOW, look at this" surface — a dedicated
// Discord channel with a dedicated ping role, fired only when a source has
// failed N scrapes in a row.
//
// State lives in bot.cache.settings.sourceAlertState[source]:
//   { consecutiveFailures: number, lastAlertAt: number | null }
//
// Failure = any non-'ok' classifyOutcome verdict (blocked, drift_listing,
// drift_detail, empty, parse_failed, extractor_not_implemented). 'empty'
// is included on purpose: a source that goes from posting 15 items to 0
// consistently is a failure even if the classifier says "empty". The
// threshold (default 3) weeds out one-off single-scrape noise.
//
// 'ok' verdicts reset the streak to 0 immediately — one good scrape means
// the source is working, no need to wait for the streak to "age out".
//
// Dedupe: once an alert fires for a source, don't re-fire for the same
// source inside DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES. Audit log records
// every occurrence regardless.
//
// All state reads/writes go through `mutate(bot, fn)` so a concurrent
// scrape tick can't corrupt the object mid-update.

const { auditLog } = require('../core/auditLogger');
const {
    DEFAULT_SOURCE_ALERT_THRESHOLD,
    DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES
} = require('../config/constants');

function ensureAlertState(bot) {
    bot.cache.settings.sourceAlertState = bot.cache.settings.sourceAlertState || {};
    return bot.cache.settings.sourceAlertState;
}

function getThreshold(bot) {
    const v = bot.cache.settings.sourceAlertThreshold;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SOURCE_ALERT_THRESHOLD;
}

function getCooldownMs(bot) {
    const v = bot.cache.settings.sourceAlertCooldownMinutes;
    const minutes = Number.isFinite(v) && v > 0 ? v : DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES;
    return minutes * 60 * 1000;
}

// Human-readable reason for the Discord alert body. Maps the classifier's
// verdict to a "why this is bad" one-liner plus an actionable suggestion.
function describeVerdict(verdict) {
    switch (verdict.status) {
        case 'blocked':
            return 'site looks blocked (captcha / cloudflare / access denied) — headless browser may need a real profile or proxy';
        case 'dom_drift_listing':
            return 'listing selectors matched nothing — the site likely changed its DOM; update extractors/<type>/<name>.js listing selectors';
        case 'dom_drift_detail':
            return 'detail-page title extraction failed on every listing link — update extractors/<type>/<name>.js detail title selectors';
        case 'empty':
            return 'listing yielded links but every detail page produced zero items — either the site is genuinely empty, or extraction broke in a way the classifier did not catch';
        case 'parse_failed':
            return 'listing yielded links but no detail was successfully scraped — check the extractor for a runtime error';
        case 'extractor_not_implemented':
            return 'no real extractor file exists for this source (only a stub); either delete the source wrapper or implement the extractor';
        default:
            return `classifier returned unrecognized status "${verdict.status}"`;
    }
}

// Record a source's scrape outcome and fire an alert if the streak has
// crossed the threshold and the cooldown window has elapsed.
//
// Returns { fired: boolean, reason?: string, streak: number }.
async function recordOutcome(bot, source, type, verdict, meta = {}) {
    const state = ensureAlertState(bot);
    const prev = state[source] || { consecutiveFailures: 0, lastAlertAt: null };

    if (verdict.status === 'ok') {
        // Reset immediately on any success.
        state[source] = { consecutiveFailures: 0, lastAlertAt: prev.lastAlertAt || null };
        bot.saveCache();
        return { fired: false, streak: 0 };
    }

    const streak = (prev.consecutiveFailures || 0) + 1;
    state[source] = { consecutiveFailures: streak, lastAlertAt: prev.lastAlertAt || null };

    const threshold = getThreshold(bot);
    if (streak < threshold) {
        bot.saveCache();
        return { fired: false, streak };
    }

    const cooldownMs = getCooldownMs(bot);
    const now = Date.now();
    if (prev.lastAlertAt && (now - prev.lastAlertAt) < cooldownMs) {
        bot.saveCache();
        return { fired: false, streak, reason: 'cooldown' };
    }

    // Fire.
    state[source].lastAlertAt = now;
    bot.saveCache();

    const reason = describeVerdict(verdict);
    const metaStr = meta && Object.keys(meta).length > 0
        ? ` (${JSON.stringify(meta).slice(0, 200)})`
        : '';

    // Always audit — regardless of whether the Discord send succeeds.
    auditLog('source_alert', `Source "${source}" (${type}) failed ${streak} scrapes in a row — ${reason}`, {
        source, type, streak, threshold, verdict, meta
    }, 'error');

    // Best-effort Discord delivery.
    await deliverAlert(bot, source, type, streak, threshold, reason, metaStr, verdict);

    return { fired: true, streak };
}

async function deliverAlert(bot, source, type, streak, threshold, reason, metaStr, verdict) {
    const env = require('../config/env');
    const { normalizeRoleId } = require('../config/roles');
    const channelId = env.ALERTS_CHANNEL_ID;
    // Normalize role ID so a .env value wrapped as <@&123...> (a common paste
    // mistake) doesn't double-wrap here the way it once did in post-formatting.
    const roleId = normalizeRoleId(env.ALERTS_PING_ROLE_ID);

    if (!channelId) {
        console.warn(`⚠️ [alerts] ALERTS_CHANNEL_ID not set — source alert for "${source}" logged to audit only.`);
        return;
    }

    const pingPrefix = roleId ? `<@&${roleId}> ` : '';
    const title = `${pingPrefix}🚨 **Source failure alert**`;
    const body = [
        title,
        `Source: **${source}** (${type})`,
        `Consecutive failures: **${streak}** (threshold ${threshold})`,
        `Why: ${reason}`,
        `Verdict: \`${verdict.status}\`${metaStr}`
    ].join('\n');

    try {
        const channel = await bot.client.channels.fetch(channelId);
        if (!channel) {
            console.warn(`⚠️ [alerts] ALERTS_CHANNEL_ID ${channelId} not found — alert not delivered.`);
            return;
        }
        await channel.send({ content: body.slice(0, 2000) });
    } catch (error) {
        console.error('❌ [alerts] Failed to deliver source alert to Discord:', error.message);
        auditLog('source_alert_delivery_error', `Failed to deliver source alert for "${source}" to Discord: ${error.message}`, {
            source, type, channelId, errorMessage: error.message, errorCode: error.code || null
        }, 'error');
    }
}

// Convenience: snapshot the current alert state for /status or /health
// display. Returns array of { source, consecutiveFailures, lastAlertAt }.
function getAlertSnapshot(bot) {
    const state = ensureAlertState(bot);
    return Object.entries(state).map(([source, s]) => ({
        source,
        consecutiveFailures: s.consecutiveFailures || 0,
        lastAlertAt: s.lastAlertAt || null
    }));
}

module.exports = {
    recordOutcome,
    getAlertSnapshot,
    describeVerdict
};
