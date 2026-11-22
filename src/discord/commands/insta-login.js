'use strict';
// /insta-login — re-authenticate Instagram from Discord.
//   start [relogin]  run scripts/insta-login.js (headed), check cookies, then headless verify
//   verify           headless verify of the saved cookies
//   status           read-only look at data/instagram/cookies.json
// Admin only (Discord permission + ADMIN_USER_IDS allowlist). All replies ephemeral.
// Cookie values are never posted: every outgoing string is scrubbed against the cookie file's values.

const fs = require('fs');
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const runner = require('../../core/instaLoginRunner');

const EPHEMERAL = MessageFlags.Ephemeral;

const definition = new SlashCommandBuilder()
    .setName('insta-login')
    .setDescription('Re-authenticate Instagram for the social scraper (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) => sc
        .setName('start')
        .setDescription('Open a login window on the bot host and save fresh cookies')
        .addBooleanOption((o) => o
            .setName('relogin')
            .setDescription('Force a fresh login (default: true)')))
    .addSubcommand((sc) => sc.setName('verify').setDescription('Check the saved session is still live (headless)'))
    .addSubcommand((sc) => sc.setName('status').setDescription('Show saved cookie state (read-only)'));

const adminIds = (env) => String(env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function handle(bot, interaction, deps = {}) {
    const r = { ...runner, ...(deps.runner || {}) };
    const env = deps.env || process.env;
    const cookieFile = deps.cookieFile || runner.COOKIE_FILE;
    const progressMs = deps.progressMs === undefined ? 3000 : deps.progressMs;

    const ids = adminIds(env);
    if (!ids.includes(interaction.user.id)) {
        const content = ids.length ? '⛔ /insta-login is restricted to bot admins.' : '⛔ ADMIN_USER_IDS is not set, so /insta-login is locked.';
        return interaction.reply({ content, flags: EPHEMERAL });
    }

    const sub = interaction.options.getSubcommand();
    const vals = () => r.cookieValues(cookieFile);
    const safe = (t, n = 1900) => r.scrub(String(t), vals()).slice(0, n);

    if (sub === 'status') {
        const chk = r.checkCookies({ file: cookieFile });
        const content = chk.ok
            ? `✅ Required cookies present (saved ${chk.savedAt || 'unknown'}). ${chk.sessionOnly ? 'sessionid has no fixed expiry.' : `sessionid expires in ${chk.remaining}.`} Run /insta-login verify to confirm the session is live.`
            : `❌ ${chk.reason}`;
        return interaction.reply({ content: safe(content), flags: EPHEMERAL });
    }

    if (r.isBusy()) return interaction.reply({ content: '⏳ A login run is already in progress.', flags: EPHEMERAL });

    const node = r.resolveNode({ env });
    if (sub === 'start' && !node.headedOk) {
        return interaction.reply({
            content: '❌ No display available for a headed login (DISPLAY unset and no Windows node.exe found). Set INSTA_LOGIN_NODE or run scripts/insta-login.js by hand.',
            flags: EPHEMERAL
        });
    }

    let pre = null;
    if (sub === 'verify') {
        pre = r.checkCookies({ file: cookieFile });
        if (!pre.ok) return interaction.reply({ content: safe(`❌ ${pre.reason}`), flags: EPHEMERAL });
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    const startedAt = Date.now();
    const recent = [];
    let header = '';
    let dirty = false;
    const render = () => `${header}\n\`\`\`\n${recent.slice(-6).map((l) => safe(l, 200)).join('\n')}\n\`\`\``.slice(0, 1900);
    const timer = setInterval(async () => {
        if (!dirty) return;
        dirty = false;
        try { await interaction.editReply({ content: render() }); } catch (e) { /* rate limit / expired: ignore */ }
    }, progressMs);
    if (timer.unref) timer.unref();
    const onLine = (l) => { recent.push(l); dirty = true; };
    const logToChannel = async (msg) => {
        try { if (bot && typeof bot.sendLogMessage === 'function') await bot.sendLogMessage(safe(msg, 500)); } catch (e) { /* ignore */ }
    };
    const finalReply = async (content) => {
        clearInterval(timer);
        try { await interaction.editReply({ content: safe(content) }); }
        catch (e) { console.error('[insta-login] final editReply failed:', e.message); }
    };

    try {
        let chk = pre;
        if (sub === 'start') {
            const relogin = interaction.options.getBoolean('relogin') ?? true;
            const requireFresh = relogin || !fs.existsSync(cookieFile);
            header = `🔐 Instagram login: a browser window is opening on the bot host. Log in there (up to ${r.LOGIN_TIMEOUT_S}s).`;
            dirty = true;
            await logToChannel(`🔐 /insta-login start by ${interaction.user.tag} (${interaction.user.id})`);
            const args = ['--timeout', String(r.LOGIN_TIMEOUT_S)];
            if (relogin) args.push('--relogin');
            const res = await r.runScript(args, { hardKillMs: r.LOGIN_KILL_MS, onLine, node, env });
            const msg = r.describeExit(res.code, res);
            if (msg) { await logToChannel(`❌ /insta-login start failed: ${msg}`); return await finalReply(`❌ ${msg}`); }
            chk = r.checkCookies({ file: cookieFile, startedAt, requireFresh });
            if (!chk.ok) { await logToChannel(`❌ /insta-login start: ${chk.reason}`); return await finalReply(`❌ Login failed: ${chk.reason}`); }
        }

        header = '🔎 Verifying the session in a headless browser…';
        dirty = true;
        const vres = await r.runScript(['--verify', '--headless'], { hardKillMs: r.VERIFY_KILL_MS, onLine, node, env });
        const vmsg = r.describeExit(vres.code, vres);
        if (vmsg) { await logToChannel(`❌ /insta-login ${sub}: verify failed: ${vmsg}`); return await finalReply(`❌ Login failed: ${vmsg}`); }

        const expiry = chk.sessionOnly
            ? 'sessionid is a browser-session cookie (no fixed expiry; Instagram may still expire it in 2–4 weeks).'
            : `Session expires in ${chk.remaining}.`;
        await logToChannel(`✅ /insta-login ${sub} OK (${interaction.user.tag})`);
        return await finalReply(`✅ Logged in and verified. ${expiry} Cookies saved ${chk.savedAt || 'at an unknown time'}. Required: ${r.REQUIRED.join(', ')} present.`);
    } catch (e) {
        if (e && e.code === 'BUSY') return await finalReply('⏳ A login run is already in progress.');
        console.error('[insta-login] unexpected error:', e);
        return await finalReply(`❌ Unexpected error: ${e && e.message ? e.message : e}`);
    } finally {
        clearInterval(timer);
    }
}

module.exports = { definition, handle };
