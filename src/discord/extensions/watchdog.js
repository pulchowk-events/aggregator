// src/discord/extensions/watchdog.js
// Connection watchdog. Adds visibility on gateway disconnect/reconnect
// events — discord.js already auto-reconnects, this just tells you when
// it happens and writes an audit entry for forensics.

const { auditLog } = require('../../core/auditLogger');
const discordLog = require('../../core/discordLog');

function attachWatchdog(bot) {
    bot.client.on('shardDisconnect', (event, shardId) => {
        console.warn(`⚠️ [watchdog] Shard ${shardId} disconnected (code ${event && event.code}).`);
        auditLog('gateway_disconnect', `Shard ${shardId} disconnected`, { shardId, code: (event && event.code) || null }, 'error');
        discordLog.send(bot, {
            status: 'warn',
            title: `Discord gateway disconnected · shard ${shardId}`,
            description: `Code ${(event && event.code) || 'unknown'} · reconnecting automatically.`,
            footer: 'watchdog',
        }).catch(() => {});
    });
    bot.client.on('shardReconnecting', (shardId) => {
        console.log(`🔄 [watchdog] Shard ${shardId} reconnecting...`);
        auditLog('gateway_reconnecting', `Shard ${shardId} reconnecting`, { shardId });
    });
    bot.client.on('shardResume', (shardId, replayedEvents) => {
        console.log(`✅ [watchdog] Shard ${shardId} resumed (${replayedEvents} events replayed).`);
        auditLog('gateway_resume', `Shard ${shardId} resumed`, { shardId, replayedEvents });
        discordLog.send(bot, {
            status: 'pass',
            title: `Discord gateway reconnected · shard ${shardId}`,
            footer: 'watchdog',
        }).catch(() => {});
    });
}

module.exports = { attachWatchdog };
