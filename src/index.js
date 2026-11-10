// src/index.js
// Entry point. Constructs the bot, wires the optional integrations
// (extensions, supabase, websiteSync — added in future commits), installs
// signal handlers, and starts.
//
// Every attach() call is lazy — if the module doesn't exist yet (during
// incremental rollout), the require throws and we log a clear message
// instead of crashing.

const EventsBot = require('./bot');

const bot = new EventsBot();

function tryAttach(label, requireFn) {
    try {
        const mod = requireFn();
        if (typeof mod === 'function') {
            mod(bot);
        } else if (mod && typeof mod.attach === 'function') {
            mod.attach(bot);
        }
        console.log(`🧩 ${label} attached`);
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            console.log(`ℹ️ ${label} module not present yet — skipping`);
        } else {
            console.error(`❌ Failed to attach ${label}:`, error);
        }
    }
}

tryAttach('extensions',   () => require('./discord/extensions'));
tryAttach('supabase',     () => require('./integrations/supabase'));
tryAttach('websiteSync',  () => require('./integrations/websiteSync'));

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
    console.error('❌ Unhandled promise rejection:', reason);
});
