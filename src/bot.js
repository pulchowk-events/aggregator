// src/bot.js
// EventsBot — composition root. Constructs the Discord client, loads the
// cache, wires every module into a single class instance, and exposes
// methods that callers (command handlers, extensions, integrations) can
// use. Almost every method here is a 1-3 line delegate — the actual logic
// lives in the modules built previously.
//
// The only methods that carry real logic:
//   - constructor (state assembly)
//   - validateConfig (startup warnings)
//   - setupDiscordHandlers (registers interactionCreate / ready / error)
//   - start / shutdown (process lifecycle)
//
// The 4 methods that MUST exist as instance methods (because
// botExtensions.js monkey-patches them): postEventToCategory,
// _processScrapedEventsLocked, removeFromPending, markEventPosted.

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cors = require('cors');
const path = require('path');

const env = require('./config/env');
const { Mutex } = require('./core/mutex');
const { auditLog } = require('./core/auditLogger');
const { ScrapeProgressTracker } = require('./scrapers/progress');
const cacheModule = require('./core/cache');
const dedup = require('./posting/dedup');
const category = require('./posting/category');
const gates = require('./posting/gates');
const reconcile = require('./posting/reconcile');
const post = require('./posting/post');
const pipeline = require('./posting/pipeline');
const autopost = require('./posting/autopost');
const schedule = require('./posting/schedule');
const consistency = require('./posting/consistency');
const dateUtils = require('./core/dateUtils');
const { parseEventDate } = require('./core/dateUtils');
const { normalizeEventName } = require('./core/normalize');
const { sanitizeEventFields } = require('./core/sanitize');
const { formatEventMessage, formatJobMessage, formatScholarshipMessage } = require('./core/formatting');
const markers = require('./core/markers');
const { pickRandom } = require('./config/emojis');

// Category channel map (populated from env at construction time). Both
// test and main channel IDs live here — post.js resolves mode → channelId
// from this.CATEGORIES[category][mode].
const CATEGORIES = env.CHANNELS;

class EventsBot {
    constructor() {
        this.validateConfig();

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        this.app = express();
        this.app.use(cors(env.DASHBOARD_ALLOWED_ORIGINS.length > 0
            ? { origin: env.DASHBOARD_ALLOWED_ORIGINS }
            : {}));
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.static(path.join(__dirname, '..', 'public')));

        this.cacheMutex = new Mutex();
        this._cacheDirty = false;
        this._saveCacheTimer = null;

        // Autopost track state.
        const freshTrack = () => ({
            test: { active: false, intervalMinutes: 60 },
            live: { active: false, intervalMinutes: 60 }
        });
        this.autopostConfig = { events: freshTrack(), jobs: freshTrack(), scholarships: freshTrack() };
        this.autopostTimers = {
            events: { test: null, live: null },
            jobs: { test: null, live: null },
            scholarships: { test: null, live: null }
        };
        this.autopostIdleLogState = {
            events: { test: 0, live: 0 },
            jobs: { test: 0, live: 0 },
            scholarships: { test: 0, live: 0 }
        };
        this.autopostNightBlockLogState = {
            events: { live: 0 }, jobs: { live: 0 }, scholarships: { live: 0 }
        };

        this.cache = cacheModule.loadCache(this);
        this.autopostLastPostAt = this.cache.settings.autopostLastPostAt || {
            events: { test: 0, live: 0 },
            jobs: { test: 0, live: 0 },
            scholarships: { test: 0, live: 0 }
        };

        this.isScraping = false;
        this.cronTask = null;
        this.consistencyCheckCronTask = null;
        this.missedScrapeCheckCronTask = null;
        this.server = null;
        this.lastMissedScrapeLogAt = 0;
        this.activeScrapeCron = this.cache.settings.scrapeCron || env.SCRAPE_CRON;

        this.postingLocks = new Set();
        this.scrapeProgress = new ScrapeProgressTracker();

        this.CATEGORIES = CATEGORIES;

        this.setupDiscordHandlers();
    }

    // ---------- Startup validation ----------

    validateConfig() {
        const problems = env.validateConfig();
        if (problems.length > 0) {
            console.warn('⚠️  Startup configuration warnings:');
            problems.forEach((p) => console.warn(`   - ${p}`));
        }
    }

    // ---------- Discord handler wiring ----------

    // Delegates to src/discord/onReady.js on 'ready', src/discord/interaction.js
    // on 'interactionCreate'. Both modules are lazy-required inside the
    // callbacks so this file loads even before those modules exist — the
    // require only fires when Discord actually connects.
    setupDiscordHandlers() {
        this.client.once('ready', () => {
            console.log(`✅ Bot logged in as ${this.client.user.tag}`);
            require('./discord/onReady').onReady(this);
        });

        this.client.on('interactionCreate', (interaction) => {
            require('./discord/interaction').handleInteraction(this, interaction);
        });

        this.client.on('error', (err) => console.error('❌ Discord client error:', err));
        this.client.on('shardError', (err) => console.error('❌ Discord shard error:', err));
    }

    // ---------- Cache wrappers (4 critical for monkey-patching) ----------

    saveCache() { cacheModule.saveCache(this); }
    flushCacheSync() { cacheModule.flushCacheSync(this); }
    loadCache() { return cacheModule.loadCache(this); }

    removeFromPending(eventId) { cacheModule.removeFromPending(this, eventId); }
    markEventPosted(event) { cacheModule.markEventPosted(this, event); }

    // ---------- Dedup wrappers (used by extensions + integrations) ----------

    getEventDedupKey(event) { return dedup.getEventDedupKey(event); }
    findFuzzyDuplicateMatch(event, pool) { return dedup.findFuzzyDuplicateMatch(event, pool); }
    deduplicateEventsByKey(arr) { return dedup.deduplicateEventsByKey(arr); }
    normalizeEventName(name) { return normalizeEventName(name); }

    // ---------- Date wrappers (used by extensions + integrations) ----------

    parseEventDate(event) { return parseEventDate(event); }
    isEventPast(event) { return dateUtils.isEventPast(event); }
    isEventTooSoon(event) {
        return dateUtils.isEventTooSoon(event, autopost.getAutopostMinLeadDays(this));
    }
    compareByEventDate(a, b) { return dateUtils.compareByEventDate(a, b); }

    // ---------- Category + gates wrappers ----------

    determineCategory(event) { return category.determineCategory(event); }
    hasValidImage(event) { return gates.hasValidImage(this, event); }
    hasDataQualityWarnings(event) { return gates.hasDataQualityWarnings(event); }
    shouldPingForEvent(event, categoryKey) {
        if (categoryKey) event._pingCategoryKey = categoryKey;
        try {
            return gates.shouldPingForEvent(this, event);
        } finally {
            if (categoryKey) delete event._pingCategoryKey;
        }
    }

    // ---------- Sanitize wrapper ----------

    sanitizeEventFields(event) { return sanitizeEventFields(event); }

    // ---------- Marker wrappers (used by extensions for /undo etc.) ----------

    readPostedMarker(event, channelId) {
        const key = this.getEventDedupKey(event);
        return markers.read(key, channelId);
    }
    reservePostedMarker(event, channelId, force = false) {
        const key = this.getEventDedupKey(event);
        return markers.reserve(key, channelId, { title: event.title, force });
    }
    confirmPostedMarker(event, channelId) {
        const key = this.getEventDedupKey(event);
        return markers.confirm(key, channelId, { title: event.title });
    }
    releasePostedMarker(event, channelId) {
        const key = this.getEventDedupKey(event);
        return markers.release(key, channelId, { title: event.title });
    }

    // ---------- Reconciliation wrappers ----------

    verifyNotPostedOnDiscord(event, channelId) {
        return reconcile.verifyNotPostedOnDiscord(this, event, channelId);
    }
    hasBeenPostedToChannel(event, channelId) {
        return reconcile.hasBeenPostedToChannel(this, event, channelId);
    }
    lastPostedToChannelAt(event, channelId) {
        return reconcile.lastPostedToChannelAt(this, event, channelId);
    }

    // ---------- Posting wrapper (patched by botExtensions) ----------

    async postEventToCategory(event, mode, categoryKeyOverride = null, force = false) {
        return post.postEventToCategory(this, event, mode, categoryKeyOverride, force);
    }

    // ---------- Pipeline wrappers (patched by botExtensions + supabase/websiteSync) ----------

    async _processScrapedEventsLocked(events, errors) {
        return pipeline.processScrapedEvents(this, events, errors);
    }

    purgeExpiredPendingEvents() { return pipeline.purgeExpiredPendingEvents(this); }
    purgeStuckNeedsAttentionEvents() { return pipeline.purgeStuckNeedsAttentionEvents(this); }
    getNeedsAttentionExpiryDays() { return pipeline.getNeedsAttentionExpiryDays(this); }
    isStuckNeedsAttentionEvent(event) { return pipeline.isStuckNeedsAttentionEvent(this, event); }
    reconcilePendingAgainstMarkers() {
        const channelIds = consistency.allConfiguredChannelIds(this);
        return pipeline.reconcilePendingAgainstMarkers(this, channelIds);
    }

    // ---------- Scrape entry (used by cron, missed-catchup, /scrape) ----------

    async scrapeAndNotify(site = 'all') {
        return require('./discord/scrapeAndNotify').scrapeAndNotify(this, site);
    }

    // ---------- Consistency wrappers ----------

    runConsistencyCheck() { return consistency.runConsistencyCheck(this); }
    scheduleConsistencyCheck() { return consistency.scheduleConsistencyCheck(this); }
    cleanupStaleMarkerFiles(retentionMs) {
        return markers.cleanupStaleMarkers(retentionMs);
    }

    // ---------- Autopost wrappers ----------

    getAutopostItemTypes() { return autopost.getItemTypes(); }
    getAutopostModes() { return autopost.getModes(); }
    matchesAutopostItemType(event, itemType) { return autopost.matchesAutopostItemType(event, itemType); }
    formatAutopostInterval(minutes) { return autopost.formatAutopostInterval(minutes); }
    getAutopostMinLeadDays() { return autopost.getAutopostMinLeadDays(this); }
    isWithinLiveAutopostWindow() { return autopost.isWithinLiveAutopostWindow(); }
    persistAutopostState() { return autopost.persistAutopostState(this); }
    startAutopost(itemType, mode, intervalMinutes = 60, options = {}) {
        return autopost.startAutopost(this, itemType, mode, intervalMinutes, options);
    }
    stopAutopost(itemType, mode) { return autopost.stopAutopost(this, itemType, mode); }
    stopAutopostDeliberately(itemType, mode) { return autopost.stopAutopostDeliberately(this, itemType, mode); }
    setAutopostInterval(itemType, mode, minutes) {
        return autopost.setAutopostInterval(this, itemType, mode, minutes);
    }
    resumeOrWarnAutopostAfterRestart() {
        return autopost.resumeOrWarnAutopostAfterRestart(this);
    }
    runAutopostTick(itemType, mode) { return autopost.runAutopostTick(this, itemType, mode); }

    // ---------- Schedule wrappers ----------

    scheduleAutomaticScraping() { return schedule.scheduleAutomaticScraping(this); }
    rescheduleWithCustomCron(expr) { return schedule.rescheduleWithCustomCron(this, expr); }
    getNextScrapeTime() { return schedule.getNextScrapeTime(this); }
    getLastScheduledScrapeTime() { return schedule.getLastScheduledScrapeTime(this); }
    wasLastScrapeCycleMissed() { return schedule.wasLastScrapeCycleMissed(this); }
    isMissedScrapeCatchupEnabled() { return schedule.isMissedScrapeCatchupEnabled(this); }
    checkForMissedScrapeAndCatchUp() { return schedule.checkForMissedScrapeAndCatchUp(this); }
    scheduleMissedScrapeCheck() { return schedule.scheduleMissedScrapeCheck(this); }

    // ---------- Formatting wrappers ----------

    formatEventMessage(event, ping = null) { return formatEventMessage(event, ping); }
    formatJobMessage(job, ping = null) { return formatJobMessage(job, ping); }
    formatScholarshipMessage(s, ping = null) { return formatScholarshipMessage(s, ping); }
    getRandomEmoji(arr) { return pickRandom(arr); }

    // ---------- sendLogMessage ----------

    async sendLogMessage(content) {
        try {
            const channelId = this.cache.settings.logsChannelId;
            if (channelId) {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send(content);
            } else {
                console.log(`[log, no channel configured] ${content}`);
            }
        } catch (error) {
            console.error('❌ Error sending log message:', error);
            auditLog('discord_api_error', 'sendLogMessage() failed to fetch/send to the logs channel', {
                logsChannelId: this.cache.settings.logsChannelId || null,
                errorMessage: error.message, errorCode: error.code || null, errorStack: error.stack
            }, 'error');
        }
    }

    // ---------- Lifecycle ----------

    async start() {
        try {
            await this.client.login(env.DISCORD_TOKEN);
        } catch (error) {
            console.error('❌ Failed to login:', error);
            process.exit(1);
        }
    }

    async shutdown() {
        console.log('🛑 Shutting down bot...');
        if (this.cronTask) this.cronTask.stop();
        if (this.consistencyCheckCronTask) this.consistencyCheckCronTask.stop();
        if (this.missedScrapeCheckCronTask) this.missedScrapeCheckCronTask.stop();

        // Deliberate stop for every autopost track, so a subsequent boot
        // does NOT resume them (matching the /autopost stop semantics).
        for (const t of this.getAutopostItemTypes()) {
            for (const m of this.getAutopostModes()) {
                this.stopAutopostDeliberately(t, m);
            }
        }

        this.flushCacheSync();

        if (this.server) this.server.close();
        try {
            await this.client.destroy();
        } catch (e) { /* ignore */ }
    }
}

module.exports = EventsBot;
