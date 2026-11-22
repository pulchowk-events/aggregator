'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ext = require('../src/scrapers/extractors/social/instagram.js');
const I = ext._internal;

// ---- inline scrubbed fixture: structure from the real tiles (bundle L / part C), text shortened.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
function tile({ href, alt, labels = [], src = 'https://cdn.example.invalid/t.jpg' }) {
    const svgs = labels.map((l) => '<svg aria-label="' + l + '" class="x1" role="img" viewBox="0 0 24 24"><title>' + l + '</title><path d="M0 0"></path></svg>').join('');
    return '<a class="x1i10hfl _a6hd" href="' + href + '" role="link" tabindex="0"><div class="_aagu"><div class="_aagv" style="padding-bottom: 133.333%;">' +
        '<img alt="' + esc(alt) + '" class="x5yr21d" crossorigin="anonymous" src="' + src + '" style="object-fit: cover;"></div></div>' +
        '<div class="html-div">' + svgs + '</div></a>';
}
const ALT_EXPO = 'ONLINE PROJECT EXHIBITION | LOCUS 2027 IS LIVE!\nGot a tech project? Put your innovation in the spotlight! \u{1F4A1}\u2728\nSoftware > Hardware | IoT\nRegister Now: bit.ly/Online_Project_Expo\n\n#LOCUS2027 #OnlineProjectExhibition';
const ALT_PROJ = 'Project Name: CollegeBuddy | Team ID: 19\nOnline Project Exhibition | LOCUS 2027\nShowcase your tech project, get recognized &amp; compete for exciting prizes!\n\n#LOCUS2027';
const AUTO = (d) => 'Photo by LOCUS, IOE Pulchowk on ' + d + '. May be a graphic of poster, magazine and text.';
const PIN = ['Pinned post icon'];
const CLIP = ['Clip'];
const TILES = [
    { href: '/locus_ioe/p/Deo1UA6hr7T/', alt: AUTO('October 18, 2026'), labels: PIN },
    { href: '/locus_ioe/p/De4L-t8D9YI/', alt: AUTO('October 24, 2026'), labels: PIN },
    { href: '/locus_ioe/reel/De_uDW1Bcni/', alt: ALT_EXPO, labels: PIN },
    { href: '/locus_ioe/reel/DgAX4jQoxQW/', alt: ALT_PROJ, labels: CLIP },
    { href: '/locus_ioe/reel/DgASqwWonnT/', alt: 'Project Name: Manimater | Team ID: 24', labels: CLIP },
    { href: '/locus_ioe/reel/Df9lL_EvL-u/', alt: 'Project Name: Ashlya | Team ID: 15', labels: CLIP },
    { href: '/locus_ioe/reel/Df7Ldb0Nj5t/', alt: 'Project Name: Dhara | Team ID: 9', labels: CLIP },
    { href: '/locus_ioe/p/Df6KP88uCQF/', alt: 'Photo shared by LOCUS, IOE Pulchowk on November 18, 2026 tagging @anilbk100. May be an image of poster and text.', labels: [] },
    { href: '/locus_ioe/reel/Df4oxqQBakA/', alt: 'Project Name: EtonNote | Team ID: 18', labels: CLIP },
    { href: '/locus_ioe/reel/Df4gENCtAW1/', alt: 'Project Name: Hydration Dispenser | Team ID: 3', labels: CLIP },
    { href: '/locus_ioe/reel/Df2AwKcN5M1/', alt: 'Project Name: Suraksha360 | Team ID: 17', labels: CLIP },
    { href: '/locus_ioe/reel/Df1v_zatGGF/', alt: 'Project Name: LipiAI | Team ID: 8', labels: CLIP }
];
const HTML = '<html><body><header><h2>locus_ioe</h2></header><a href="/explore/">Explore</a>' +
    '<a href="/other_club/p/Zzzzzzzzzzz/">decoy</a>' + TILES.map(tile).join('') + '</body></html>';
const NOW = Date.UTC(2026, 10, 22, 0, 0);

test('parseTilesFromHtml: 12 tiles, decoys ignored, kinds and pins', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    assert.equal(tiles.length, 12);
    assert.equal(tiles.filter((t) => t.kind === 'reel').length, 9);
    assert.equal(tiles.filter((t) => t.kind === 'post').length, 3);
    assert.deepEqual(tiles.filter((t) => t.isPinned).map((t) => t.code), ['Deo1UA6hr7T', 'De4L-t8D9YI', 'De_uDW1Bcni']);
    assert.equal(tiles[3].iconKind, 'clip');
    assert.equal(I.parseTilesFromHtml(HTML, 'LOCUS_IOE').length, 12, 'username match is case-insensitive');
    assert.equal(I.parseTilesFromHtml(HTML, 'nobody').length, 0);
    assert.equal(I.parseTilesFromHtml('', 'locus_ioe').length, 0);
});

test('classifyAlt: auto text vs caption', () => {
    assert.deepEqual(I.classifyAlt(AUTO('October 18, 2026')), { kind: 'auto', text: null, altDate: '2026-10-18' });
    assert.equal(I.classifyAlt(TILES[7].alt).altDate, '2026-11-18');
    assert.equal(I.classifyAlt(ALT_EXPO).kind, 'text');
    assert.equal(I.classifyAlt('').kind, 'none');
});

test('buildItemFromTile: reel takes caption from alt (and decodes double-encoded &amp;)', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    const expo = I.buildItemFromTile(tiles[2], { club: 'locus_ioe', nowMs: NOW });
    assert.equal(expo.kind, 'reel');
    assert.equal(expo.captionSource, 'tile-alt');
    assert.ok(expo.caption.startsWith('ONLINE PROJECT EXHIBITION'));
    assert.ok(expo.caption.includes('Software > Hardware'), 'quote-aware tag parse keeps ">" in alt');
    assert.equal(expo.mediaType, 2);
    assert.equal(expo.isPinned, true);
    assert.equal(expo.url, 'https://www.instagram.com/reel/De_uDW1Bcni/');
    assert.ok(expo.title.startsWith('locus_ioe: ONLINE PROJECT EXHIBITION'));
    const proj = I.buildItemFromTile(tiles[3], { club: 'locus_ioe', nowMs: NOW });
    assert.ok(proj.caption.includes('recognized & compete'));
});

test('buildItemFromTile: photo post has no caption yet, time from shortcode', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    const p = I.buildItemFromTile(tiles[0], { club: 'locus_ioe', nowMs: NOW });
    assert.equal(p.kind, 'post');
    assert.equal(p.caption, null);
    assert.equal(p.takenAtSource, 'shortcode');
    assert.ok(p.takenAt.startsWith('2026-10-1'));
    assert.equal(p.mediaType, 1);
    assert.equal(p.url, 'https://www.instagram.com/p/Deo1UA6hr7T/');
    assert.equal(p.title, 'locus_ioe: Instagram post');
    assert.deepEqual(p.flags, []);
});

test('selectNewTiles: cold start seeds everything, returns nothing', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    const sel = I.selectNewTiles(tiles, { seenSet: new Set(), nowMs: NOW, sinceHours: 72, coldStart: true });
    assert.equal(sel.candidates.length, 0);
    assert.equal(sel.markSeen.length, 12);
    assert.equal(sel.seeded, 12);
});

test('selectNewTiles: warm run returns only young unseen tiles, marks stale ones seen', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    const seen = new Set(tiles.map((t) => t.code).filter((c) => c !== 'DgAX4jQoxQW' && c !== 'Df6KP88uCQF'));
    const sel = I.selectNewTiles(tiles, { seenSet: seen, nowMs: NOW, sinceHours: 36, coldStart: false });
    assert.deepEqual(sel.candidates.map((t) => t.code), ['DgAX4jQoxQW']);   // ~Nov 21
    assert.equal(sel.stale, 1);                                             // Df6K is ~Nov 18
    assert.deepEqual(sel.markSeen.sort(), ['DgAX4jQoxQW', 'Df6KP88uCQF'].sort());
    const again = I.selectNewTiles(tiles, { seenSet: new Set(tiles.map((t) => t.code)), nowMs: NOW, sinceHours: 36, coldStart: false });
    assert.equal(again.candidates.length, 0);
});

test('applyDetail fills caption and flags a date mismatch', () => {
    const tiles = I.parseTilesFromHtml(HTML, 'locus_ioe');
    const item = I.buildItemFromTile(tiles[0], { club: 'locus_ioe', nowMs: NOW });
    I.applyDetail(item, { caption: 'Real caption', captionSource: 'og-description', takenDate: '2026-10-18', children: [] });
    assert.equal(item.caption, 'Real caption');
    assert.equal(item.title, 'locus_ioe: Real caption');
    assert.equal(item.flags.includes('takenAt_mismatch'), false);
    I.applyDetail(item, { takenDate: '2026-01-01', children: [] });
    assert.equal(item.flags.includes('takenAt_mismatch'), true);
});

test('classifyProfileState', () => {
    const base = { url: 'https://www.instagram.com/locus_ioe/', anchors: 0, hasHeader: true, hasLoginForm: false, bodyText: '' };
    const c = (o, opt) => I.classifyProfileState(Object.assign({}, base, o), opt);
    assert.equal(c({ anchors: 12 }), 'ok');
    assert.equal(c({ anchors: 12, hasLoginForm: true }), 'login', 'logged-out view shows tiles AND a login form');
    assert.equal(c({ url: 'https://www.instagram.com/accounts/login/?next=%2Flocus_ioe%2F' }), 'login');
    assert.equal(c({ url: 'https://www.instagram.com/challenge/abc/' }), 'challenge');
    assert.equal(c({ bodyText: "Sorry, this page isn't available." }), 'not_found');
    assert.equal(c({ bodyText: 'No posts yet' }), 'empty');
    assert.equal(c({ bodyText: 'This account is private' }), 'private');
    assert.equal(c({}), 'loading');
    assert.equal(c({}, { timedOut: true }), 'layout_changed');
    assert.equal(I.classifyProfileState(null), 'loading');
});

test('waitForProfile: waits for a stable anchor count, detects login', async () => {
    const mk = (anchors, extra) => Object.assign({ url: 'https://www.instagram.com/locus_ioe/', anchors, hasHeader: true, hasLoginForm: false, bodyText: '' }, extra);
    const fake = (probes) => { let i = 0; return { evaluate: async () => probes[Math.min(i++, probes.length - 1)] }; };
    const noSleep = async () => {};
    let r = await I.waitForProfile(fake([mk(0), mk(12), mk(12)]), 'locus_ioe', { sleep: noSleep, timeoutMs: 1000 });
    assert.equal(r.state, 'ok');
    assert.equal(r.probe.anchors, 12);
    r = await I.waitForProfile(fake([mk(0, { url: 'https://www.instagram.com/accounts/login/' })]), 'locus_ioe', { sleep: noSleep, timeoutMs: 1000 });
    assert.equal(r.state, 'login');
    r = await I.waitForProfile(fake([mk(0)]), 'locus_ioe', { sleep: noSleep, timeoutMs: 20 });
    assert.equal(r.state, 'layout_changed');
});

test('loadClubs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-clubs-'));
    const f = path.join(dir, 'clubs.json');
    fs.writeFileSync(f, JSON.stringify(['locus_ioe', { username: '@Club_B', label: 'B' }, { username: 'bad name!' }, 'LOCUS_IOE', { username: 'off', enabled: false }]));
    const r = I.loadClubs(f);
    assert.deepEqual(r.clubs.map((c) => c.username), ['locus_ioe', 'club_b']);
    assert.deepEqual(r.invalid, ['bad name!']);
    fs.writeFileSync(f, '[]');
    assert.deepEqual(I.loadClubs(f).clubs, []);
    assert.ok(I.loadClubs(path.join(dir, 'missing.json')).error);
});

test('cookie helpers', () => {
    const c = I.normalizeCookie({ name: 'sessionid', value: 'x', domain: '.instagram.com', expires: 4102444800, httpOnly: true, sameSite: 'no_restriction' });
    assert.equal(c.sameSite, 'None');
    assert.equal(c.secure, true);
    assert.equal(I.normalizeCookie({ name: 'a' }), null);
    const ok = [I.normalizeCookie({ name: 'sessionid', value: 'x' }), I.normalizeCookie({ name: 'ds_user_id', value: '1' })];
    assert.equal(I.hasSessionCookies(ok), true);
    assert.equal(I.hasSessionCookies(ok.slice(0, 1)), false);
    assert.equal(I.hasSessionCookies([{ name: 'sessionid', value: 'x', expires: 1 }, ok[1]]), false);
});

test('module contract', () => {
    assert.equal(typeof ext.extract, 'function');
    assert.equal(typeof ext.preprocessItem, 'function');
    const cfg = I.readConfig({});
    assert.equal(cfg.minIntervalMs, 24 * 3600000);
    assert.equal(cfg.forceReseed, false);
    assert.equal(I.readConfig({ IG_FORCE_RESEED: '1' }).forceReseed, true);
});
