// src/index.js
// Entry point. Constructs the bot, wires the optional integrations,
// installs signal handlers, and starts.
//
// Every attach() call is lazy — if the module doesn't exist yet (during
// incremental rollout), the require throws and we log a clear message
// instead of crashing.
//
// Output shape: the attach sequence prints one line per integration under
// a single banner, then hands off to bot.start() which prints its own
// login + onReady sequences. Attach is synchronous and fast (sub-100ms);
// the wall-clock time between "attached" lines and "bot online" is the
// Discord login handshake, which is outside this module's control.

const EventsBot = require('./bot');
const ui = require('./core/ui');

const bot = new EventsBot();

ui.banner({
    title: 'Pulchowk Events Bot',
    sub: 'attaching integrations'
});

function tryAttach(label, requireFn) {
    try {
        const mod = requireFn();
        if (typeof mod === 'function') {
            mod(bot);
        } else if (mod && typeof mod.attach === 'function') {
            mod.attach(bot);
        }
        ui.line(`  ${ui.colors.GREEN}✓${ui.colors.R}  ${label}`);
        return true;
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            ui.line(`  ${ui.colors.GRAY}·${ui.colors.R}  ${label}  ${ui.colors.GRAY}(not present — skipping)${ui.colors.R}`);
        } else {
            ui.line(`  ${ui.colors.RED}✗${ui.colors.R}  ${label}  ${ui.colors.GRAY}${error.message}${ui.colors.R}`);
            console.error(`[index] Failed to attach ${label}:`, error);
        }
        return false;
    }
}

tryAttach('extensions',   () => require('./discord/extensions'));
tryAttach('supabase',     () => require('./integrations/supabase'));
tryAttach('websiteSync',  () => require('./integrations/websiteSync'));

ui.blank();

bot.start();

process.on('SIGINT', async () => {
    await bot.shutdown();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await bot.shutdown();
    process.exit(0);
});
process.on('unhandledRejection', (reason) => {
    console.error('✗ Unhandled promise rejection:', reason);
});