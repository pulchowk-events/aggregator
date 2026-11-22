'use strict';
// Fixtures: og: tag layout is copied from LIVE pages captured in S2.5 (attribute
// order, trailing space, &quot;/&amp; encoding). Captions are the real ones, with
// personal phone numbers and @handles scrubbed. JSON blobs are SYNTHETIC: the real
// blob's key-paths were never established.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/scrapers/lib/insta-detail-parse');
const { decodeShortcodeTimestamp, shortcodeToMediaId } = require('../src/scrapers/lib/insta-shortcode');
const ext = require('../src/scrapers/extractors/social/instagram.js');

const NOW = Date.UTC(2026, 10, 23);
const POST_CODE = 'Deo1UA6hr7T';
const POST_ID = '4010689940009959123';
const REEL_CODE = 'De_uDW1Bcni';
const REEL_ID = '4017131933447604706';

// Ground truth (user-pasted from the app), phones/handles scrubbed.
const GT_POST = [
    'Online Project Exhibition | LOCUS',
    'Build it. Film it. Showcase it.',
    '',
    'Got a project ready to showcase? \u{1F4A1}\u2728',
    'Turn your ideas into something that gets recognised!',
    '',
    'The LOCUS 2027 Online Project Exhibition invites students to showcase their innovative projects across Software & Hardware/ Electronics/ IoT.',
    '',
    '\u{1F517} Register Now : bit.ly/Online_Project_Expo',
    '',
    '\u{1F4BB} SOFTWARE',
    'Web & Mobile Apps | AI/ML | Games',
    'Tools & Utilities | Creative Tech | and more',
    '',
    '\u2699\uFE0F HARDWARE / ELECTRONICS / IoT',
    'Embedded System | Robotics | IoT Solution',
    'Prototypes | Smart Devices | and more',
    '',
    '\u{1F39F}\uFE0F FREE REGISTRATION',
    '\u{1F3C6} Rs 15,000 PRIZE POOL',
    '\u{1F393} School, +2, Bachelor-level students, Anyone Interested ',
    '\u{1F465} Teams of 1\u20134 members',
    '',
    'Whether it\u2019s an app, an AI solution, a robotic system, an IoT prototype, or your next big idea - this is your chance to put your project in the spotlight! \u{1F525}',
    '',
    '\u{1F4F2} For More Information:',
    '@user : 9XXXXXXXXX',
    '@user : 9XXXXXXXXX',
    '',
    '[#LOCUS2027 #OnlineProjectExhibition #LOCUS #23rdNationalTechnologicalFestival #ProjectExhibition StudentProjects Technology Innovation Engineering Software Hardware IoT Robotics AI MachineLearning CreativeTech Nepal ]'
].join('\n');

const GT_REEL = [
    'ONLINE PROJECT EXHIBITION | LOCUS 2027 IS LIVE!',
    'Got a tech project? Put your innovation in the spotlight! \u{1F4A1}\u2728',
    'Showcase your project, get recognized, connect with opportunities, and compete for exciting prizes! \u{1F3C6}',
    '\u{1F4BB} Software',
    '\u2699\uFE0F Hardware | \u{1F50C} Electronics | \u{1F310} IoT',
    '\u{1F3AF} Build it. Film it. Showcase it.',
    '\u{1F517} Register Now: bit.ly/Online_Project_Expo',
    '',
    '[Online Project Exhibition, LOCUS 2027, Student Project Exhibition, Tech Project Competition, Engineering Projects, Software Projects, Hardware Projects, IoT Projects, Student Innovation',
    '#LOCUS2027 #OnlineProjectExhibition #TechProject #StudentInnovation #EngineeringProjects ]'
].join('\n');

const scrub = (s) => s.replace(/@[A-Za-z0-9._]+/g, '@user').replace(/\b\d{10}\b/g, '9XXXXXXXXX');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return 'first diff at ' + i + ' (len ' + a.length + ' vs ' + b.length + '): got ' +
        JSON.stringify(a.slice(i, i + 20)) + ' want ' + JSON.stringify(b.slice(i, i + 20));
}

// Mirrors the live tag order/encoding (incl. the trailing space after the description).
function page({ code, kind, owner = 'locus_ioe', stats = '37 likes, 2 comments', dateText, caption, rawDesc, mediaId, scripts = '' }) {
    const label = kind === 'reel' ? 'reel' : 'photo';
    const seg = kind === 'reel' ? 'reel' : 'p';
    const desc = rawDesc !== undefined ? rawDesc : (stats + ' - ' + owner + ' on ' + dateText + ': "' + caption + '".');
    return [
        '<!DOCTYPE html><html><head>',
        '<meta charset="utf-8">',
        '<meta property="og:type" content="article">',
        '<meta name="twitter:title" content="LOCUS, IOE Pulchowk (@' + owner + ') \u2022 Instagram ' + label + '">',
        '<meta property="al:ios:url" content="instagram://media?id=' + mediaId + '">',
        '<meta name="description" content="' + esc(desc) + ' ">',
        '<meta property="og:title" content="' + esc('LOCUS, IOE Pulchowk on Instagram: "' + caption + '"') + '">',
        '<meta property="og:image" content="https://cdn.example.invalid/v/t51/x.webp?stp=c288&amp;oh=SCRUBBED">',
        '<meta property="og:url" content="https://www.instagram.com/' + owner + '/' + seg + '/' + code + '/">',
        '<meta property="og:description" content="' + esc(desc) + ' ">',
        '</head><body>' + scripts + '</body></html>'
    ].join('\n');
}

const jsonScript = (obj) => '<script type="application/json" data-sjs>' + JSON.stringify(obj) + '</script>';
const relay = (node) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: { data: { xdt_api__v1_media__shortcode__web_info: { items: [node] } } } } }]]] });

// ---------------------------------------------------------------- ground-truth tests

test('photo post: real caption parsed verbatim from og:description (phones/handles scrubbed)', () => {
    const html = page({ code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: GT_POST, mediaId: POST_ID });
    const r = P.parseDetailHtml(html, { code: POST_CODE, nowMs: NOW });
    assert.equal(r.caption, GT_POST, firstDiff(r.caption || '', GT_POST));
    assert.equal(r.captionSource, 'og-description');
    assert.equal(r.captionTruncated, false);
    assert.ok(r.caption.includes('Anyone Interested \n'), 'trailing space before newline preserved');
    assert.ok(r.caption.includes('Software & Hardware'), '&amp; decoded exactly once');
    assert.equal(r.takenDate, '2026-10-18');
    assert.equal(r.username, 'locus_ioe');
    assert.equal(r.pageCode, POST_CODE);
    assert.equal(r.socialKind, 'photo');
    assert.equal(r.mediaType, null, 'og alone cannot tell photo from carousel');
    assert.equal(r.thumbnailUrl, 'https://cdn.example.invalid/v/t51/x.webp?stp=c288&oh=SCRUBBED');
    assert.equal(r.found.og, true);
    assert.equal(r.found.json, false);
});

test('reel page parses via og and agrees with the grid alt-text path', () => {
    const html = page({ code: REEL_CODE, kind: 'reel', dateText: 'October 27, 2026', stats: '34 likes, 3 comments', caption: GT_REEL, mediaId: REEL_ID });
    const r = P.parseDetailHtml(html, { code: REEL_CODE, nowMs: NOW });
    assert.equal(r.caption, GT_REEL, firstDiff(r.caption || '', GT_REEL));
    assert.equal(r.captionSource, 'og-description');
    assert.equal(r.takenDate, '2026-10-27');
    assert.equal(r.socialKind, 'reel');
    assert.equal(r.mediaType, 2);
    const alt = ext._internal.classifyAlt(GT_REEL);
    assert.equal(alt.kind, 'text');
    assert.equal(alt.text, r.caption, 'tile alt and detail page yield the same caption');
});

test('shortcode decodes to the media id Instagram publishes (al:ios:url), and dates agree', () => {
    assert.equal(shortcodeToMediaId(POST_CODE), BigInt(POST_ID));
    assert.equal(shortcodeToMediaId(REEL_CODE), BigInt(REEL_ID));
    const post = P.parseDetailHtml(page({ code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: 'c', mediaId: POST_ID }), { code: POST_CODE, nowMs: NOW });
    const reel = P.parseDetailHtml(page({ code: REEL_CODE, kind: 'reel', dateText: 'October 27, 2026', caption: 'c', mediaId: REEL_ID }), { code: REEL_CODE, nowMs: NOW });
    assert.equal(post.mediaId, POST_ID);
    assert.equal(post.mediaIdMatchesShortcode, true);
    assert.equal(reel.mediaIdMatchesShortcode, true);
    const bad = P.parseDetailHtml(page({ code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: 'c', mediaId: '4010689940009959124' }), { code: POST_CODE, nowMs: NOW });
    assert.equal(bad.mediaIdMatchesShortcode, false);
    assert.equal(new Date(decodeShortcodeTimestamp(POST_CODE, { nowMs: NOW })).toISOString().slice(0, 10), post.takenDate);
    assert.equal(new Date(decodeShortcodeTimestamp(REEL_CODE, { nowMs: NOW })).toISOString().slice(0, 10), reel.takenDate);
});

// ---------------------------------------------------------------- JSON path (synthetic)

test('JSON taken_at cross-checks against shortcode time within 1s (SYNTHETIC blob)', () => {
    const ms = decodeShortcodeTimestamp(POST_CODE, { nowMs: NOW });
    const node = { code: POST_CODE, taken_at: Math.floor(ms / 1000), media_type: 1, product_type: 'feed', caption: { text: 'x' } };
    const html = page({ code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: 'x', mediaId: POST_ID, scripts: jsonScript(relay(node)) });
    const r = P.parseDetailHtml(html, { code: POST_CODE, nowMs: NOW });
    assert.equal(r.found.json, true);
    assert.equal(r.takenAt, new Date(node.taken_at * 1000).toISOString());
    assert.ok(r.takenAtCheck);
    assert.ok(Math.abs(r.takenAtCheck.deltaMs) <= 1000, 'delta ' + r.takenAtCheck.deltaMs);
    assert.equal(r.takenAtCheck.agrees, true);
    assert.equal(r.productType, 'feed');

    node.taken_at += 3600;
    const off = P.parseDetailHtml(page({ code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: 'x', mediaId: POST_ID, scripts: jsonScript(relay(node)) }), { code: POST_CODE, nowMs: NOW });
    assert.equal(off.takenAtCheck.agrees, false);
    assert.equal(P.crossCheckTakenAt('garbage', POST_CODE, { nowMs: NOW }), null);
    assert.equal(P.crossCheckTakenAt(new Date(ms).toISOString(), 'bad$code', { nowMs: NOW }), null);
});

test('JSON node selection: thin references and other posts do not shadow the full node', () => {
    const thin = { code: POST_CODE, media_type: 1 };
    const other = { code: 'OtherCode01', caption: { text: 'nope' }, taken_at: 1 };
    const full = { code: POST_CODE, taken_at: 1792331520, media_type: 1, caption: { text: 'Full caption' }, image_versions2: { candidates: [{ url: 'https://example.invalid/i.jpg' }] } };
    const html = '<html><body>' + jsonScript({ a: [thin, other], b: { items: [full] } }) + '</body></html>';
    const r = P.parseDetailHtml(html, { code: POST_CODE, nowMs: NOW });
    assert.equal(r.found.json, true);
    assert.equal(r.caption, 'Full caption');
    assert.equal(r.captionSource, 'detail-json');
    assert.equal(r.imageUrl, 'https://example.invalid/i.jpg');
    assert.equal(r.diag.jsonNodes, 2);
    assert.equal(P.findMediaNode({ x: [thin, full] }, POST_CODE), full);
    const none = P.parseDetailHtml('<script type="application/json">' + JSON.stringify({ items: [other] }) + '</script>', { code: POST_CODE, nowMs: NOW });
    assert.equal(none.found.json, false);
    assert.equal(none.caption, null);
});

test('caption policy: og wins on conflict; truncated or prefix-only og is upgraded from JSON', () => {
    const mk = (ogCaption, jsonCaption) => P.parseDetailHtml(page({
        code: POST_CODE, kind: 'post', dateText: 'October 18, 2026', caption: ogCaption, mediaId: POST_ID,
        scripts: jsonScript(relay({ code: POST_CODE, taken_at: 1792331520, caption: { text: jsonCaption } }))
    }), { code: POST_CODE, nowMs: NOW });

    const conflict = mk('From og', 'From json');
    assert.equal(conflict.caption, 'From og');
    assert.equal(conflict.captionSource, 'og-description');
    assert.equal(conflict.captionConflict, true);

    const same = mk('Same text', 'Same  text');
    assert.equal(same.captionConflict, false, 'whitespace-only differences are not conflicts');

    const trunc = mk('Hello world...', 'Hello world and much more');
    assert.equal(trunc.caption, 'Hello world and much more');
    assert.equal(trunc.captionSource, 'detail-json');
    assert.equal(trunc.captionTruncated, false);

    const prefix = mk('Hello world', 'Hello world and more');
    assert.equal(prefix.caption, 'Hello world and more');
    assert.equal(prefix.captionUpgradedFromJson, true);
});

test('carousel (SYNTHETIC): children captured, capped at 10', () => {
    const kids = Array.from({ length: 12 }, (_, i) => ({ media_type: 1, image_versions2: { candidates: [{ url: 'https://example.invalid/' + i + '.jpg' }] } }));
    const node = { code: POST_CODE, taken_at: 1792331520, media_type: 8, product_type: 'carousel_container', caption: { text: 'c' }, carousel_media: kids };
    const r = P.parseDetailHtml('<html><body>' + jsonScript(relay(node)) + '</body></html>', { code: POST_CODE, nowMs: NOW });
    assert.equal(r.mediaType, 8);
    assert.equal(r.children.length, 10);
    assert.equal(r.children[0].url, 'https://example.invalid/0.jpg');
});

// ---------------------------------------------------------------- og edge cases

test('page for a different post is rejected, not attributed', () => {
    const html = page({ code: 'AAAAAAAAAAA', kind: 'post', dateText: 'October 18, 2026', caption: 'someone else', mediaId: POST_ID });
    const r = P.parseDetailHtml(html, { code: POST_CODE, nowMs: NOW });
    assert.equal(r.codeMismatch, true);
    assert.equal(r.caption, null);
    assert.equal(r.found.og, false);
});

test('og:title fallback, date-only description, truncation flag', () => {
    const t = P.parseDetailHtml('<meta property="og:title" content="Club on Instagram: &quot;Only the title&quot;">' +
        '<meta property="og:description" content="something unparseable">', {});
    assert.equal(t.caption, 'Only the title');
    assert.equal(t.captionSource, 'og-title');

    const d = P.parseDetailHtml(page({ code: POST_CODE, kind: 'post', caption: 'From title', rawDesc: '5 likes - locus_ioe on October 18, 2026', mediaId: POST_ID }), { code: POST_CODE, nowMs: NOW });
    assert.equal(d.takenDate, '2026-10-18');
    assert.equal(d.caption, 'From title');
    assert.equal(d.captionSource, 'og-title');

    const long = 'locus_ioe on October 18, 2026: "A long caption that was cut off..."';
    const tr = P.parseDetailHtml('<meta property="og:description" content="' + esc(long) + '">', {});
    assert.equal(tr.captionTruncated, true);
});

test('garbage in, empty result out; helpers', () => {
    for (const bad of [null, undefined, '', 42, '<html></html>']) {
        const r = P.parseDetailHtml(bad, { code: 'x' });
        assert.equal(r.caption, null);
        assert.equal(r.found.json, false);
    }
    assert.equal(P.decodeHtmlEntities('a &amp; b &#x1F4A1; &lt;'), 'a & b \u{1F4A1} <');
    assert.equal(P.toIsoDate('October', '18', '2026'), '2026-10-18');
    assert.equal(P.toIsoDate('Octember', '18', '2026'), null);
    assert.equal(P.toIsoDate('February', '31', '2026'), null);
    assert.equal(P.parseOgDescription('nothing useful'), null);
    assert.equal(P.parseOgDescription('1.2K likes, 56 comments - a_b.c on May 3, 2026: "hi".').caption, 'hi');
});

// ---------------------------------------------------------------- live saved pages (not committed; skipped if absent)

const ART = path.join(os.homedir(), 'insta-s2-artifacts');
const LIVE_POST = path.join(ART, 'insta-post-page.html');
const LIVE_REEL = path.join(ART, 'insta-reel-page.html');

test('LIVE saved post page: caption equals ground truth', { skip: !fs.existsSync(LIVE_POST) && 'saved page not present' }, () => {
    const r = P.parseDetailHtml(fs.readFileSync(LIVE_POST, 'utf8'), { code: POST_CODE, nowMs: NOW });
    console.log('LIVE post diag ' + JSON.stringify({
        source: r.captionSource, truncated: r.captionTruncated, conflict: r.captionConflict, upgraded: r.captionUpgradedFromJson,
        foundJson: r.found.json, diag: r.diag, takenAt: r.takenAt, takenAtCheck: r.takenAtCheck,
        mediaType: r.mediaType, productType: r.productType, children: r.children.length, mediaIdMatches: r.mediaIdMatchesShortcode
    }));
    assert.equal(r.codeMismatch, false);
    const got = scrub(r.caption || '');
    assert.equal(got, GT_POST, firstDiff(got, GT_POST));
    assert.equal(r.takenDate, '2026-10-18');
    assert.equal(r.mediaIdMatchesShortcode, true);
});

test('LIVE saved reel page: caption equals the grid alt text', { skip: !fs.existsSync(LIVE_REEL) && 'saved page not present' }, () => {
    const r = P.parseDetailHtml(fs.readFileSync(LIVE_REEL, 'utf8'), { code: REEL_CODE, nowMs: NOW });
    console.log('LIVE reel diag ' + JSON.stringify({
        source: r.captionSource, conflict: r.captionConflict, foundJson: r.found.json, diag: r.diag,
        takenAt: r.takenAt, takenAtCheck: r.takenAtCheck, mediaType: r.mediaType, mediaIdMatches: r.mediaIdMatchesShortcode
    }));
    assert.equal(r.codeMismatch, false);
    const got = scrub(r.caption || '');
    assert.equal(got, GT_REEL, firstDiff(got, GT_REEL));
    assert.equal(r.takenDate, '2026-10-27');
    assert.equal(r.socialKind, 'reel');
    assert.equal(r.mediaType, 2);
    assert.equal(r.mediaIdMatchesShortcode, true);
});
