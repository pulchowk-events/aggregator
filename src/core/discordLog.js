// src/core/discordLog.js
// Discord-side counterpart to src/core/ui.js. Every log message that
// used to be a bare "🌙 Autopost holding off..." string becomes an embed
// with the same status palette (green = pass, yellow = warn, red = fail,
// blue = info, gray = muted) and the same ✓/⚠/✗ prefix tag the terminal
// uses.
//
// Callers go through `send(bot, opts)` which routes to
// `bot.sendLogEmbed()`. `bot.sendLogMessage(string)` stays for backward
// compat — any caller that still passes a plain string works unchanged.
//
// Shape:
//   {
//     title: '...',                    // required
//     status: 'pass'|'warn'|'fail'|'info'|'muted',   // default: info
//     description: '...',              // optional, one paragraph
//     fields: [{ name, value, inline? }],   // optional, up to 25 per embed
//     footer: '...',                   // optional, one line
//     timestamp: true,                 // default: true
//   }
//
// For high-volume messages (autopost per-tick summary, website sync
// completion), one embed with N inline fields replaces N separate
// one-line messages. For one-off events (gateway reconnect, /shutdown),
// one embed with a short title.

const { EmbedBuilder } = require('discord.js');

const COLORS = {
    pass:  0x2ECC71,  // green
    warn:  0xF1C40F,  // yellow
    fail:  0xE74C3C,  // red
    info:  0x3498DB,  // blue
    muted: 0x95A5A6,  // gray
};

const TAG = {
    pass:  '✓',
    warn:  '⚠',
    fail:  '✗',
    info:  '·',
    muted: '·',
};

// Build an EmbedBuilder from a compact options object. Pure — no
// network. Safe to build embeds for tests without a bot instance.
function build({ title, status = 'info', description, fields, footer, timestamp = true } = {}) {
    const safeStatus = COLORS[status] ? status : 'info';
    const embed = new EmbedBuilder().setColor(COLORS[safeStatus]);

    if (title) {
        const tag = TAG[safeStatus];
        embed.setTitle(tag ? `${tag}  ${title}` : title);
    }
    if (description) embed.setDescription(description);
    if (Array.isArray(fields) && fields.length > 0) {
        embed.addFields(fields.slice(0, 25).map((f) => ({
            name: String(f.name || ''),
            value: String(f.value ?? ''),
            inline: f.inline !== false,
        })));
    }
    if (footer) embed.setFooter({ text: String(footer) });
    if (timestamp) embed.setTimestamp();

    return embed;
}

// Send via the bot. String input falls through to the legacy
// bot.sendLogMessage(string) path so nothing breaks during rollout.
// Options input builds an embed and goes through bot.sendLogEmbed (added
// to bot.js in the next patch).
async function send(bot, opts) {
    if (typeof opts === 'string') {
        return bot.sendLogMessage(opts);
    }
    if (!bot || typeof bot.sendLogEmbed !== 'function') {
        // Fallback while bot.js is mid-patch: send the title as a plain
        // string so at least something reaches the logs channel.
        const fallback = opts && opts.title ? `[log] ${opts.title}` : '[log]';
        return bot && typeof bot.sendLogMessage === 'function'
            ? bot.sendLogMessage(fallback)
            : console.log(fallback);
    }
    return bot.sendLogEmbed(build(opts));
}

module.exports = { build, send, COLORS, TAG };
