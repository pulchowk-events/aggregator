#!/usr/bin/env node
'use strict';
// One-shot import of the newest N posts per club into posts.json and the website clubs feed.
//   node scripts/clubs-import-recent.js                      DRY RUN: browses Instagram (read-only), writes nothing
//   node scripts/clubs-import-recent.js --apply              real writes (posts.json + website), club by club
//   --per N (default 4, max 12)   --limit-clubs N (default 5)   --clubs a,b,c (overrides --limit-clubs)
// Run where the real session lives (-win, Windows node) with the bot STOPPED:
// the browser profile cannot be opened twice, and the bot writes seen/ and posts.json.
// Never posts to Discord, never touches seen/. Aborts on the first login redirect or challenge.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const truthy = (v) => v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => (hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1)));
const ascii = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?');

function parseArgs(argv) {
    const o = { apply: false, per: 4, limitClubs: 5, clubs: null, error: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') o.apply = true;
        else if (a === '--per') o.per = Number(argv[++i]);
        else if (a === '--limit-clubs') o.limitClubs = Number(argv[++i]);
        else if (a === '--clubs') o.clubs = String(argv[++i] || '').split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
        else { o.error = 'unknown argument: ' + a; return o; }
    }
    if (!Number.isInteger(o.per) || o.per < 1 || o.per > 12) o.error = '--per must be an integer 1..12';
    else if (!Number.isInteger(o.limitClubs) || o.limitClubs < 1 || o.limitClubs > 50) o.error = '--limit-clubs must be an integer 1..50';
    else if (o.clubs && o.clubs.length === 0) o.error = '--clubs needs at least one username';
    return o;
}

// Newest first by takenAt; items without a time go last; ties keep page order.
function pickNewest(items, n) {
    const t = (x) => { const ms = x && x.takenAt ? Date.parse(x.takenAt) : NaN; return Number.isFinite(ms) ? ms : -1; };
    return (items || []).map((x, i) => ({ x, i })).sort((a, b) => (t(b.x) - t(a.x)) || (a.i - b.i)).slice(0, n).map((o) => o.x);
}

function itemLine(item) {
    const cap = ascii(String(item.caption || '').replace(/\s+/g, ' ').slice(0, 70));
    return '  ' + item.shortcode + ' ' + item.kind + ' ' + (item.takenAt || 'no-time') + ' | ' + cap +
        (item.flags && item.flags.length ? ' | flags=' + item.flags.join(',') : '');
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.error) { console.error('ERROR: ' + o.error); process.exit(1); }
    if (o.apply) process.env.WEBSITE_SYNC_DRY_RUN = 'false';
    const env = require(path.join(ROOT, 'src/config/env'));
    if (o.apply) {
        env.WEBSITE_SYNC_DRY_RUN = false;
        if (truthy(env.DEV_MODE) || truthy(process.env.DEV_MODE)) { console.error('STOP: DEV_MODE is set.'); process.exit(1); }
        if (!truthy(env.WEBSITE_CLUBS_SYNC_ENABLED) && !truthy(process.env.WEBSITE_CLUBS_SYNC_ENABLED)) { console.error('STOP: WEBSITE_CLUBS_SYNC_ENABLED is not true.'); process.exit(1); }
        if (!truthy(env.WEBSITE_CLUBS_IMAGES_ENABLED) && !truthy(process.env.WEBSITE_CLUBS_IMAGES_ENABLED)) { console.error('STOP: WEBSITE_CLUBS_IMAGES_ENABLED is not true (Instagram image URLs expire).'); process.exit(1); }
        const g = require(path.join(ROOT, 'src/integrations/websiteSync/clubImages')).checkHost('clubs-import');
        if (g) { console.error('STOP: host guard refused. Set WEBSITE_CLUBS_CONFIRM_HOST=' + (g.host || '<host>') + '.'); process.exit(1); }
    }

    const ig = require(path.join(ROOT, 'src/scrapers/extractors/social/instagram'))._internal;
    const { CLUBS_FILE, COOKIE_FILE } = require(path.join(ROOT, 'src/posting/socialPaths'));
    const { createSeenStore } = require(path.join(ROOT, 'src/scrapers/lib/insta-seen-store'));
    const { recordPost, postsStore } = require(path.join(ROOT, 'src/posting/socialPostsStore'));
    const { clubsStore } = require(path.join(ROOT, 'src/posting/socialClubs'));
    const ops = require(path.join(ROOT, 'src/integrations/websiteSync/clubsOps'));
    const { withPage, closeBrowser } = require(path.join(ROOT, 'src/scrapers/browser'));
    const { loadPage } = require(path.join(ROOT, 'src/scrapers/page'));

    const loaded = ig.loadClubs(CLUBS_FILE);
    if (!loaded.clubs.length) { console.error('STOP: no clubs in ' + CLUBS_FILE + (loaded.error ? ' (' + loaded.error + ')' : '')); process.exit(1); }
    let picked;
    if (o.clubs) {
        picked = loaded.clubs.filter((c) => o.clubs.includes(c.username));
        const missing = o.clubs.filter((u) => !picked.some((c) => c.username === u));
        if (missing.length) console.warn('WARN: not in clubs.json: ' + missing.join(', '));
    } else picked = loaded.clubs.slice(0, o.limitClubs);
    if (!picked.length) { console.error('STOP: no clubs selected'); process.exit(1); }

    const ck = ig.readCookieFile(COOKIE_FILE);
    if (!ck.ok) { console.error('STOP: instagram session unusable: ' + ck.reason); process.exit(1); }
    const store = createSeenStore();
    const cfg = ig.readConfig();
    const state = store.readState();
    if (state.challengeCooldownUntil && Date.parse(state.challengeCooldownUntil) > Date.now()) {
        console.error('STOP: challenge cooldown active until ' + state.challengeCooldownUntil); process.exit(1);
    }

    console.log('mode: ' + (o.apply ? 'APPLY (real writes)' : 'DRY RUN (nothing written)') + ' | per club: ' + o.per + ' | clubs: ' + picked.map((c) => c.username).join(','));
    const totals = { clubs: 0, found: 0, alreadyRecorded: 0, recorded: 0, synced: 0, syncSkipped: 0, syncFailed: 0, aborted: null };
    const nowMs = Date.now();

    try {
        await withPage(async (page) => {
            await ig.injectCookies(page, ck.cookies);
            if (typeof page.setExtraHTTPHeaders === 'function') await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            for (let i = 0; i < picked.length && !totals.aborted; i++) {
                const username = picked[i].username;
                if (i > 0) await sleep(rand(cfg.jitterMinMs, Math.max(cfg.jitterMinMs, cfg.jitterMaxMs)));
                console.log('--- @' + username + ' (' + (i + 1) + '/' + picked.length + ')');
                await loadPage(page, 'https://www.instagram.com/' + username + '/', { timeout: 60000 });
                const waited = await ig.waitForProfile(page, username);
                if (waited.state === 'login') { totals.aborted = 'login'; break; }
                if (waited.state === 'challenge') { totals.aborted = 'challenge'; break; }
                if (waited.state !== 'ok') { console.log('  profile state: ' + waited.state + ', skipped'); continue; }
                const names = await ig.readCookieNames(page);
                if (names && !names.has('sessionid')) { totals.aborted = 'login'; break; }
                const tiles = ig.parseTilesFromHtml(await page.content(), username);
                if (!tiles.length) { console.log('  no tiles parsed, skipped'); continue; }
                const items = pickNewest(tiles.map((t) => ig.buildItemFromTile(t, { club: username, nowMs })), o.per);
                totals.clubs++;
                const todo = [];
                for (const item of items) {
                    totals.found++;
                    if (postsStore.get(item.shortcode)) { totals.alreadyRecorded++; console.log('  ' + item.shortcode + ' already in posts.json, skipped'); continue; }
                    todo.push(item);
                }
                for (const item of todo) {
                    if (totals.aborted) break;
                    if (!item.caption) {
                        await sleep(rand(6000, 12000));
                        let d = null;
                        try { d = await ig.fetchDetail(page, item, loadPage); }
                        catch (e) { item.flags.push('detail_error'); }
                        if (d && d.abort) { totals.aborted = d.abort; item.flags.push('detail_aborted'); }
                        else if (d && d.parsed) ig.applyDetail(item, d.parsed);
                    }
                    console.log(itemLine(item));
                }
                if (totals.aborted) {
                    if (totals.aborted === 'challenge') { try { store.patchState({ challengeCooldownUntil: new Date(Date.now() + cfg.cooldownMs).toISOString() }); } catch (e) { /* ignore */ } }
                    break;
                }
                if (o.apply) {
                    const base = clubsStore.list().find((c) => c && c.username === username) || {};
                    const club = Object.assign({ username, label: picked[i].label }, base);
                    for (const item of todo) {
                        try { if (recordPost(item, club, postsStore)) totals.recorded++; } catch (e) { console.warn('  posts.json write failed for ' + item.shortcode + ': ' + ascii(e.message)); continue; }
                        try {
                            const r = await ops.syncPostedItem(item, club);
                            if (r && r.ok === true && r.dryRun === false) totals.synced++;
                            else if (r && (r.skipped || r.dryRun === true)) { totals.syncSkipped++; console.log('  ' + item.shortcode + ' not synced: ' + ascii(r.skipped || 'dry')); }
                            else { totals.syncFailed++; console.log('  ' + item.shortcode + ' sync failed: ' + ascii(JSON.stringify(r)).slice(0, 200)); }
                        } catch (e) { totals.syncFailed++; console.log('  ' + item.shortcode + ' sync error: ' + ascii(e.message)); }
                    }
                }
            }
        });
    } finally {
        try { await closeBrowser(); } catch (e) { /* ignore */ }
    }
    console.log('RESULT ' + JSON.stringify(totals));
    if (totals.aborted) { console.error('ABORTED: ' + totals.aborted + (totals.aborted === 'challenge' ? ' (cooldown set)' : '')); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
}

module.exports = { parseArgs, pickNewest };
if (require.main === module) main().catch((e) => { console.error('import failed: ' + ascii(e && e.message)); process.exit(1); });
