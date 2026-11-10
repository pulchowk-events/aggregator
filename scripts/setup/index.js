#!/usr/bin/env node
// scripts/setup/index.js
// Interactive setup wizard. Guides a new deployment from zero to a
// working .env. Every step asks before doing anything; nothing is written
// to disk until the final diff is confirmed.
//
// Usage:
//   node scripts/setup/index.js                # real setup
//   node scripts/setup/index.js --demo         # walk through with mock data
//   node scripts/setup/index.js --resume       # skip prompts already in .env
//
// Demo mode never touches the real .env — it writes to data/demo-setup.env.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const tui = require('../wizard/tui');
const { getAdapters } = require('./adapters');
const v = require('./validators');
const { copyToClipboard, openUrl } = require('../shared/platform');

// ---------- args ----------
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const RESUME = args.includes('--resume');

// ---------- category spec ----------
// The 9 categories the bot routes to. Each has a main channel and a test
// channel. In DEMO mode we present the same channel names so the walkthrough
// feels identical to a real run.
const CATEGORY_SPEC = [
    { key: 'sports',        label: 'Sports',          main: '⚽┃sports',           test: '⚽┃sports-test',        category: 'Events' },
    { key: 'software',      label: 'Software',        main: '💻┃software',         test: '💻┃software-test',      category: 'Events' },
    { key: 'hardware',      label: 'Hardware',        main: '💡┃hardware',         test: '💡┃hardware-test',      category: 'Events' },
    { key: 'gaming',        label: 'Gaming',          main: '🎮┃gaming',           test: '🎮┃gaming-test',        category: 'Events' },
    { key: 'music',         label: 'Music',           main: '🎙️┃music',            test: '🎙️┃music-test',         category: 'Events' },
    { key: 'business',      label: 'Business',        main: '💵┃business',         test: '💵┃business-test',      category: 'Events' },
    { key: 'miscellaneous', label: 'Miscellaneous',   main: '🎈┃miscellaneous',    test: '🎈┃miscellaneous-test', category: 'Events' },
    { key: 'jobs',          label: 'Jobs',            main: '💼┃jobs-internships', test: '💼┃jobs-test',          category: 'Events' },
    { key: 'scholarships',  label: 'Scholarships',    main: '🎓┃scholarships',     test: '🎓┃scholarships-test',  category: 'Events' }
];

const PING_ROLE_SPEC = [
    { key: 'sports',        name: 'Sports Ping',        color: 0x00AE86 },
    { key: 'software',      name: 'Software Ping',      color: 0x00AE86 },
    { key: 'hardware',      name: 'Hardware Ping',      color: 0x00AE86 },
    { key: 'gaming',        name: 'Gaming Ping',        color: 0x00AE86 },
    { key: 'music',         name: 'Music Ping',         color: 0x00AE86 },
    { key: 'business',      name: 'Business Ping',      color: 0x00AE86 },
    { key: 'miscellaneous', name: 'Miscellaneous Ping', color: 0x00AE86 },
    { key: 'jobs',          name: 'Jobs Ping',          color: 0x00AE86 },
    { key: 'scholarships',  name: 'Scholarships Ping',  color: 0x00AE86 }
];

const ENV_KEYS = {
    sports: 'SPORTS_CHANNEL_ID',          sportsTest: 'TEST_SPORTS_CHANNEL_ID',
    software: 'SOFTWARE_CHANNEL_ID',      softwareTest: 'TEST_SOFTWARE_CHANNEL_ID',
    hardware: 'HARDWARE_CHANNEL_ID',      hardwareTest: 'TEST_HARDWARE_CHANNEL_ID',
    gaming: 'GAMING_CHANNEL_ID',          gamingTest: 'TEST_GAMING_CHANNEL_ID',
    music: 'MUSIC_CHANNEL_ID',            musicTest: 'TEST_MUSIC_CHANNEL_ID',
    business: 'BUSINESS_CHANNEL_ID',      businessTest: 'TEST_BUSINESS_CHANNEL_ID',
    miscellaneous: 'MISC_CHANNEL_ID',     miscellaneousTest: 'TEST_MISC_CHANNEL_ID',
    jobs: 'JOBS_CHANNEL_ID',              jobsTest: 'TEST_JOBS_CHANNEL_ID',
    scholarships: 'SCHOLARSHIPS_CHANNEL_ID', scholarshipsTest: 'TEST_SCHOLARSHIPS_CHANNEL_ID'
};

const ROLE_ENV_KEYS = {
    jobs: 'JOBS_PING_ROLE_ID',
    scholarships: 'SCHOLARSHIPS_PING_ROLE_ID'
};

const PREREQ_DOCS = [
    { label: 'Discord Developer Portal',  url: 'https://discord.com/developers/applications' },
    { label: 'Supabase Dashboard',        url: 'https://supabase.com/dashboard' },
    { label: 'Node.js downloads',         url: 'https://nodejs.org/en/download' }
];

// ---------- helpers ----------
function promptValidation(question, validator, { retry = true, mask = false } = {}) {
    return new Promise(async (resolve) => {
        while (true) {
            const raw = await tui.input(question);
            if (!raw) {
                if (!retry) return resolve(null);
                tui.warn('Cannot be empty. Try again (Ctrl+C to abort).');
                continue;
            }
            const result = validator(raw);
            if (result.ok) return resolve(result.normalized || raw);
            tui.warn(result.reason);
            if (!retry) return resolve(null);
        }
    });
}

// Select one item from a list, with a search-filter escape hatch. The list
// is displayed as a numbered menu; the user can type a number OR type text
// to filter (typing 'filter' shows the full list again).
async function selectFromList(items, { label, formatter }) {
    if (items.length === 0) { tui.warn(`No ${label}s available.`); return null; }
    console.log('');
    tui.info(`Available ${label}s:`);
    console.log('');
    items.forEach((item, i) => {
        console.log(`  ${tui.colors.CYAN}[${i + 1}]${tui.colors.R} ${formatter(item)}`);
    });
    console.log('');
    while (true) {
        const answer = await tui.input(`Pick a number (1-${items.length}), or type "new" to create one`);
        if (answer === 'new') return { __new: true };
        const n = parseInt(answer, 10);
        if (Number.isFinite(n) && n >= 1 && n <= items.length) return items[n - 1];
        tui.warn('Invalid choice — enter a number from the list, or "new"');
    }
}

// ---------- main flow ----------

async function main() {
    // Step 1 — banner
    tui.banner({ name: DEMO ? 'DEMO SETUP' : 'setup', type: 'wizard', url: DEMO ? 'data/demo-setup.env (mock)' : '.env (real)' });

    if (DEMO) {
        tui.warn('Running in DEMO mode — nothing will touch your real .env, Discord server, or Supabase projects.');
        tui.info('Output will be written to data/demo-setup.env (gitignored).');
        console.log('');
    }

    // Optional docs-opening prompt
    const openDocs = await tui.confirm('Open the prerequisite documentation pages in your browser?', { defaultYes: true });
    if (openDocs) {
        for (const doc of PREREQ_DOCS) {
            openUrl(doc.url);
            tui.success(`Opened ${doc.label}`);
        }
    }

    const adapters = getAdapters({ demo: DEMO });
    const env = new adapters.envWriter(adapters.envPath);

    // ---- Step 2 — Discord token ----
    tui.step(1, 8, 'Discord bot token');
    if (DEMO) {
        tui.info('Demo mode — any 3 dot-separated strings work (e.g. "demo.token.here").');
        tui.info('Real mode would ask for a valid Discord bot token from the Developer Portal.');
    } else {
        tui.info('Get this from https://discord.com/developers/applications → your app → Bot → Reset Token');
    }
    console.log('');

    // In demo mode use a lenient validator — the token is never sent to real
    // Discord. In real mode use the strict one.
    const tokenValidator = DEMO
        ? (raw) => {
            const trimmed = String(raw || '').trim();
            if (!trimmed) return { ok: false, reason: 'Token is empty.' };
            const parts = trimmed.split('.');
            if (parts.length !== 3) return { ok: false, reason: `Demo token must have 3 dot-separated segments (got ${parts.length}).` };
            return { ok: true, normalized: trimmed };
        }
        : v.validateDiscordToken;

    const token = await promptValidation('Token', tokenValidator, { mask: true });

    // ---- Step 3 — Connect + pick guild ----
    tui.step(2, 8, 'Connect to Discord and pick your guild');
    const sp = tui.spinner('Connecting to Discord...');
    sp.start();
    let client;
    try {
        client = await adapters.discord.connect(token);
        if (adapters.discord._setClient) adapters.discord._setClient(client);
        sp.stop(`Logged in as ${client.user.tag}`);
    } catch (error) {
        sp.fail('Connection failed');
        tui.fail(error.message);
        return 1;
    }

    const guilds = adapters.discord.listGuilds();
    if (guilds.length === 0) {
        tui.fail('The bot is not in any guilds. Invite it to your server first.');
        await adapters.discord.disconnect(client);
        return 1;
    }
    tui.info(`Found ${guilds.length} guild(s) the bot is a member of.`);
    const guildChoice = await selectFromList(guilds, {
        label: 'guild',
        formatter: (g) => `${g.name}  ${tui.colors.D}(${g.id}, ${g.memberCount} members)${tui.colors.R}`
    });

    // Perms check
    const perms = await adapters.discord.checkPermissions(guildChoice.id);
    if (!perms.readyToCreate) {
        tui.warn(`Bot lacks ManageChannels/ManageRoles in ${guildChoice.name}.`);
        tui.info('You can still proceed, but channel/role creation steps will be skipped.');
    } else {
        tui.success(`Permissions OK (${perms.memberTag})`);
    }
    env.set('HOME_GUILD_ID', guildChoice.id);

    // ---- Step 4 — Category channels ----
    tui.step(3, 8, 'Category channels (18 total: main + test per category)');
    tui.info('For each category, you can either pick an existing channel or let the wizard create it.');
    console.log('');

    const createChannels = await tui.confirm('Create channels that don\'t exist?', { defaultYes: true });

    const existingChannels = await adapters.discord.listTextChannels(guildChoice.id);
    for (const cat of CATEGORY_SPEC) {
        console.log(`  ${tui.colors.B}${cat.label}${tui.colors.R}`);
        // Main channel
        const mainChoice = await selectFromList(existingChannels, {
            label: `${cat.label} main`,
            formatter: (c) => adapters.discord.channelLabel(c)
        });
        if (mainChoice && mainChoice.__new) {
            if (!createChannels) { tui.warn('Skipping creation — using empty.'); }
            else {
                const name = await tui.input(`Channel name for ${cat.label} main`, { defaultValue: cat.main });
                const result = await adapters.discord.ensureTextChannel(guildChoice.id, name);
                if (result.ok) { tui.success(`Created #${name} (${result.channel.id})`); env.set(ENV_KEYS[cat.key], result.channel.id); }
                else tui.fail(`Failed: ${result.error}`);
            }
        } else if (mainChoice) {
            env.set(ENV_KEYS[cat.key], mainChoice.id);
        }

        // Test channel
        const testChoice = await selectFromList(existingChannels, {
            label: `${cat.label} test`,
            formatter: (c) => adapters.discord.channelLabel(c)
        });
        if (testChoice && testChoice.__new) {
            if (!createChannels) { tui.warn('Skipping creation — using empty.'); }
            else {
                const name = await tui.input(`Channel name for ${cat.label} test`, { defaultValue: cat.test });
                const result = await adapters.discord.ensureTextChannel(guildChoice.id, name);
                if (result.ok) { tui.success(`Created #${name} (${result.channel.id})`); env.set(ENV_KEYS[cat.key + 'Test'], result.channel.id); }
                else tui.fail(`Failed: ${result.error}`);
            }
        } else if (testChoice) {
            env.set(ENV_KEYS[cat.key + 'Test'], testChoice.id);
        }
        console.log('');
    }

    // ---- Step 5 — Special channels: logs / audit / alerts ----
    tui.step(4, 8, 'Logs / audit / alerts channels');
    tui.info('These are operational channels — the bot writes logs, audit trail, and failure alerts to them.');
    console.log('');
    const allChannels = await adapters.discord.listTextChannels(guildChoice.id);

    const pickOrCreateChannel = async (label, defaultName, envKey) => {
        const choice = await selectFromList(allChannels, { label, formatter: (c) => adapters.discord.channelLabel(c) });
        if (choice && choice.__new) {
            const name = await tui.input(`Channel name for ${label}`, { defaultValue: defaultName });
            const result = await adapters.discord.ensureTextChannel(guildChoice.id, name);
            if (result.ok) { tui.success(`Created #${name} (${result.channel.id})`); env.set(envKey, result.channel.id); }
            else tui.fail(`Failed: ${result.error}`);
        } else if (choice) {
            env.set(envKey, choice.id);
        }
    };

    await pickOrCreateChannel('logs channel', 'pe-bot-logs', 'LOGS_CHANNEL_ID');
    await pickOrCreateChannel('audit channel', 'pe-bot-audit', 'AUDIT_LOG_CHANNEL_ID');
    await pickOrCreateChannel('alerts channel', 'pe-bot-alerts', 'ALERTS_CHANNEL_ID');

    // ---- Step 6 — Ping roles ----
    tui.step(5, 8, 'Ping roles');
    tui.info('The bot pings these roles when it posts a live event. Categories: jobs and scholarships are');
    tui.info('softcoded (in .env). The other 7 are hardcoded in src/config/roles.js — edit that file if');
    tui.info('you want to change them for your server.');
    console.log('');

    const createRoles = await tui.confirm('Create ping roles that don\'t exist?', { defaultYes: true });
    const existingRoles = await adapters.discord.listRoles(guildChoice.id);

    for (const spec of PING_ROLE_SPEC) {
        const choice = await selectFromList(existingRoles, { label: `${spec.name} role`, formatter: (r) => adapters.discord.roleLabel(r) });
        let roleId = null;
        if (choice && choice.__new) {
            if (!createRoles) { tui.warn(`Skipping creation — no role for ${spec.key}.`); continue; }
            const result = await adapters.discord.ensureRole(guildChoice.id, spec.name, { color: spec.color });
            if (result.ok) { tui.success(`Created @${spec.name} (${result.role.id})`); roleId = result.role.id; }
            else tui.fail(`Failed: ${result.error}`);
        } else if (choice) {
            roleId = choice.id;
        }
        if (roleId) {
            if (ROLE_ENV_KEYS[spec.key]) env.set(ROLE_ENV_KEYS[spec.key], roleId);
        }
    }

    // ---- Step 7 — Supabase ----
    tui.step(6, 8, 'Supabase (bot archival + website)');
    tui.info('Two projects: one for the bot\'s archival records, one for the public website.');
    tui.info('Both are optional — you can leave them blank and the bot still runs.');
    console.log('');

    const configureBot = await tui.confirm('Configure the bot archival Supabase?', { defaultYes: true });
    if (configureBot) {
        const url = await promptValidation('Bot Supabase URL', v.validateSupabaseUrl);
        const key = await promptValidation('Bot Supabase service_role key', v.validateSupabaseKey);
        const sp2 = tui.spinner('Testing bot Supabase connection...');
        sp2.start();
        const result = await adapters.supabase.testConnection(url, key, ['events', 'scholarships']);
        sp2.stop(result.ok ? 'Bot Supabase connected, tables OK' : 'Bot Supabase connected, some tables missing', result.ok);
        env.set('SUPABASE_URL', url);
        env.set('SUPABASE_SERVICE_ROLE_KEY', key);
        for (const [name, info] of Object.entries(result.tables)) {
            if (!info.exists) {
                const sql = adapters.supabase.getCreateTableSql(name);
                const sqlUrl = adapters.supabase.getSqlEditorUrl(url);
                if (sqlUrl) openUrl(sqlUrl);
                tui.warn(`Table "${name}" missing — open SQL editor: ${sqlUrl}`);
                const copy = await tui.confirm(`Copy CREATE TABLE for "${name}" to clipboard?`, { defaultYes: true });
                if (copy && copyToClipboard(sql)) tui.success('SQL copied — paste into the Supabase SQL editor');
            }
        }
    }

    const configureWeb = await tui.confirm('Configure the website Supabase?', { defaultYes: true });
    if (configureWeb) {
        const url = await promptValidation('Website Supabase URL', v.validateSupabaseUrl);
        const key = await promptValidation('Website Supabase service_role key', v.validateSupabaseKey);
        const sp3 = tui.spinner('Testing website Supabase connection...');
        sp3.start();
        const result = await adapters.supabase.testConnection(url, key, ['events', 'jobs']);
        sp3.stop(result.ok ? 'Website Supabase connected, tables OK' : 'Website Supabase connected, some tables missing', result.ok);
        env.set('WEBSITE_SUPABASE_URL', url);
        env.set('WEBSITE_SUPABASE_SERVICE_ROLE_KEY', key);
    }

    // ---- Step 8 — Dashboard + browser ----
    tui.step(7, 8, 'Dashboard + browser profile');
    const apiKey = require('crypto').randomBytes(32).toString('hex');
    env.set('DASHBOARD_API_KEY', apiKey);
    env.set('DASHBOARD_ALLOWED_ORIGINS', 'http://localhost:6234');
    tui.success(`Generated DASHBOARD_API_KEY (${apiKey.slice(0, 8)}...)`);
    tui.info('Dashboard runs on http://localhost:6234 — set DASHBOARD_ALLOWED_ORIGINS if you call from elsewhere.');

    const wantBrowser = await tui.confirm('Configure a custom browser path (Windows only, for Cloudflare-blocked sites)?', { defaultYes: false });
    if (wantBrowser) {
        const exe = await tui.input('Path to Brave/Chrome executable');
        const dir = await tui.input('Path to user data directory');
        if (exe) env.set('BROWSER_EXECUTABLE_PATH', exe);
        if (dir) env.set('BROWSER_USER_DATA_DIR', dir);
        tui.success('Browser config saved');
    }

    // ---- Step 9 — Diff + confirm + write ----
    tui.step(8, 8, 'Write the .env file');
    const diff = env.diff();
    console.log('');
    tui.info(`Added ${diff.added.length} key(s), updated ${diff.updated.length}, unchanged ${diff.unchanged.length}.`);
    if (diff.updated.length > 0) {
        console.log('');
        tui.info('Updated (existing values overwritten):');
        diff.updated.slice(0, 10).forEach((u) => console.log(`    ${u.key}  ${tui.colors.D}${u.from.slice(0, 20)}${tui.colors.R} → ${tui.colors.GREEN}${u.to.slice(0, 20)}${tui.colors.R}`));
        if (diff.updated.length > 10) console.log(`    ${tui.colors.D}... and ${diff.updated.length - 10} more${tui.colors.R}`);
    }
    console.log('');
    const confirmWrite = await tui.confirm(`Write ${adapters.envPath}?`, { defaultYes: true });
    if (!confirmWrite) { tui.info('Skipped. Nothing written.'); await adapters.discord.disconnect(client); return 0; }

    const writeResult = env.write();
    tui.success(`Wrote ${writeResult.byteSize} bytes to ${writeResult.path}`);
    if (writeResult.backupPath) tui.info(`Backup: ${writeResult.backupPath}`);

    // ---- Optional boot test ----
    if (adapters.canBootTest) {
        const bootTest = await tui.confirm('Run a quick boot test to confirm the bot logs in?', { defaultYes: true });
        if (bootTest) {
            tui.info('Launching bot for 15 seconds...');
            const child = spawn('node', [path.join(REPO, 'src', 'index.js')], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            child.stdout.on('data', (d) => { output += d.toString(); });
            child.stderr.on('data', (d) => { output += d.toString(); });
            const killTimer = setTimeout(() => child.kill('SIGTERM'), 15000);
            await new Promise((resolve) => child.on('exit', () => { clearTimeout(killTimer); resolve(); }));
            const loggedIn = /Bot logged in as/.test(output);
            const commandsRegistered = /Slash commands registered/.test(output);
            if (loggedIn) tui.success('Boot test: bot logged in cleanly');
            else tui.fail('Boot test: bot did NOT log in — check the errors in .env or console');
            if (commandsRegistered) tui.success('Boot test: slash commands registered');
            console.log('');
            tui.info('Start the bot for real:');
            tui.info('  npm start');
        }
    } else if (DEMO) {
        tui.info('Boot test skipped (demo mode).');
    }

    await adapters.discord.disconnect(client);

    tui.info('');
    tui.success('Setup complete.');
    console.log('');
    return 0;
}

// Only run when invoked directly. Requiring this module (from tests,
// from another wizard, from anything) must NOT start the flow.
if (require.main === module) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('Setup wizard requires an interactive terminal (both stdin and stdout must be a TTY).');
        console.error('Open a real terminal and run: node scripts/setup/index.js');
        process.exit(1);
    }

    main().then((code) => process.exit(code || 0)).catch((e) => {
        console.error('');
        tui.fail(`Setup failed: ${e.message}`);
        if (e.stack) console.error(tui.colors.D + e.stack + tui.colors.R);
        process.exit(1);
    });
}

module.exports = { main };
