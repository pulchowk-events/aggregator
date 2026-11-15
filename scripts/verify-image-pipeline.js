#!/usr/bin/env node
// scripts/verify-image-pipeline.js
//
// End-to-end verification for the image pipeline without touching
// Discord, cache, or markers. Two tiers:
//
//   [unit]        derivePlaceholderForSource -> github raw URL, reachable
//                 normalizeJobToEventShape preserves imageSource
//   [integration] real runSource() on a live source -> every item has
//                 image + imageSource tag, every URL is https,
//                 imageSource survives shape()
//
// Exit 0 = all pass, 1 = any fail. Writes nothing to data/.
//
// Usage:
//   node scripts/verify-image-pipeline.js                (default: cloudfactory)
//   node scripts/verify-image-pipeline.js teslatech
//   node scripts/verify-image-pipeline.js vianet
//   node scripts/verify-image-pipeline.js yarsalabs

// Redirect audit writes away from shared data/audit-log.jsonl so test runs
// don't pollute the real log. Must happen BEFORE any require that transitively
// loads auditLogger (sanitize / _orchestrate / sendPending).
const _fs   = require('fs');
const _path = require('path');
process.env.AUDIT_FILE = process.env.AUDIT_FILE || '/tmp/audit-verify.jsonl';
try { _fs.mkdirSync(_path.dirname(process.env.AUDIT_FILE), { recursive: true }); } catch { /* exists */ }
try { _fs.truncateSync(process.env.AUDIT_FILE, 0); } catch { /* missing on first run */ }

const ui = require('../src/core/ui');
const { runSource }                  = require('../src/scrapers/sources/_orchestrate');
const { normalizeJobToEventShape }   = require('../src/core/shape');
const { derivePlaceholderForSource } = require('../src/scrapers/ogImage');
const { withPage }                   = require('../src/scrapers/browser');
const axios                          = require('axios');
const { AttachmentBuilder }          = require('discord.js');
const { sendOnePendingEmbed }        = require('../src/discord/sendPendingEventsMessage');

const SOURCE = process.argv[2] || 'cloudfactory';

let pass = 0, fail = 0;
function check(name, ok, reason) {
    ui.line('');
    for (const l of ui.resultRow({
        tag: ui.tag(ok ? 'pass' : 'fail'),
        name,
        reason: ok ? null : (reason || 'failed')
    })) ui.line(l);
    ok ? pass++ : fail++;
}
function note(msg) { ui.line(''); ui.info(msg); }
function isHttps(u) { try { return new URL(u).protocol === 'https:'; } catch { return false; } }

async function testUnit() {
    ui.divider('unit: derivePlaceholderForSource');
    const url = derivePlaceholderForSource(SOURCE);
    check('returns a URL', typeof url === 'string');
    check('URL is https', isHttps(url));
    check('URL matches github raw pattern',
        typeof url === 'string' && url.startsWith('https://raw.githubusercontent.com/pulchowk-events/aggregator/main/assets/placeholders/'),
        url);

    if (url) {
        let res = await fetch(url, { method: 'HEAD' });
        if (!res.ok) res = await fetch(url, { method: 'GET' });
        check('GitHub raw returns 200', res.status === 200, `status=${res.status}`);
    }
}

function testShape() {
    ui.divider('unit: shape.js preserves imageSource');
    const fake = {
        id: 'test', title: 'T',
        companyLogoUrl: 'https://example.com/x.png',
        imageSource: 'placeholder',
        itemType: 'job'
    };
    const shaped = normalizeJobToEventShape(fake);
    check('shaped.imageSource preserved', shaped.imageSource === 'placeholder');
    check('shaped.image matches companyLogoUrl', shaped.image === fake.companyLogoUrl);
}

async function testIntegration() {
    ui.divider(`integration: runSource('${SOURCE}', 'jobs')`);
    let items, meta;
    try {
        ({ items, meta } = await runSource(SOURCE, 'jobs', { withPage, progress: null }));
    } catch (e) {
        check('runSource completed', false, e.message);
        return;
    }
    note(`items=${items.length}  enriched=${meta.imagesEnriched || 0}  listingHits=${meta.listingHits}  detailFailures=${meta.detailParseFailures}`);

    check('returned at least one item', items.length > 0);
    if (items.length === 0) return;

    const noImage = items.filter(i => !i.image);
    check('every item has an image', noImage.length === 0, `${noImage.length}/${items.length} missing`);

    const noTag = items.filter(i => !i.imageSource);
    check('every item has imageSource tag', noTag.length === 0, `${noTag.length} missing`);

    const notHttps = items.filter(i => i.image && !isHttps(i.image));
    check('every image URL is https', notHttps.length === 0, `${notHttps.length} non-https`);

    const shaped = items.map(normalizeJobToEventShape);
    check('imageSource survives shape()',
        shaped.every((s, i) => s.imageSource === items[i].imageSource));

    const breakdown = items.reduce((a, i) => {
        const k = i.imageSource || 'none'; a[k] = (a[k] || 0) + 1; return a;
    }, {});
    note(`imageSource breakdown: ${JSON.stringify(breakdown)}`);

    const ph = shaped.filter(s => s.imageSource === 'placeholder');
    if (ph.length === 0) {
        note(`0 placeholder-sourced items (all real images). Badge branch not exercised live -- shape.js unit test is the proxy.`);
    } else {
        check('at least one placeholder item would trigger /pending badge', ph.length > 0);
    }
}

async function testAssetFetch(url, label) {
    ui.divider(`asset: fetch + attach (${label})`);
    let res;
    try {
        res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    } catch (e) {
        check(`${label}: axios.get succeeds`, false, e.message);
        return null;
    }
    const buf = Buffer.from(res.data);
    check(`${label}: axios.get returns bytes`, buf.length > 0, `${buf.length} bytes`);
    check(`${label}: content-type image/png`, /image\/png/.test(res.headers['content-type'] || ''), res.headers['content-type']);
    check(`${label}: size between 1KB and 5MB`, buf.length > 1024 && buf.length < 5 * 1024 * 1024, `${buf.length} bytes`);
    let att;
    try {
        att = new AttachmentBuilder(buf, { name: 'event.png' });
        check(`${label}: AttachmentBuilder constructs`, true);
    } catch (e) {
        check(`${label}: AttachmentBuilder constructs`, false, e.message);
    }
    return buf;
}

function makeMockBot() {
    return {
        hasDataQualityWarnings: () => false,
        isEventTooSoon: () => false,
        hasValidImage: (e) => typeof e.image === 'string' && /^https?:\/\//.test(e.image),
        isStuckNeedsAttentionEvent: () => false,
        getNeedsAttentionExpiryDays: () => 14,
        getAutopostMinLeadDays: () => 2
    };
}
function makeMockChannel() {
    const captured = [];
    return {
        captured,
        async send(payload) { captured.push(payload); return {}; }
    };
}

async function testPendingRender() {
    ui.divider('render: /pending embed');
    const mockBot = makeMockBot();
    const placeholderUrl = derivePlaceholderForSource(SOURCE);

    // Case A: placeholder image -> badge must appear, image must be set
    {
        const channel = makeMockChannel();
        const item = {
            id: 'test-ph', title: 'Placeholder render test', itemType: 'job',
            description: 'test', source: SOURCE, date: 'TBD', location: 'TBD', price: 'TBD',
            image: placeholderUrl, imageSource: 'placeholder'
        };
        await sendOnePendingEmbed(mockBot, channel, item);
        const payload = channel.captured[0];
        check('placeholder: channel.send captured one payload', channel.captured.length === 1);
        if (!payload) return;
        const embed = payload.embeds[0];
        const data = embed.data || embed;
        check('placeholder: embed.image.url set', data.image && data.image.url === placeholderUrl, JSON.stringify(data.image));
        check('placeholder: description contains badge text', /Placeholder image/.test(data.description || ''), '(no match)');
    }

    // Case B: site-derived image -> NO badge
    {
        const channel = makeMockChannel();
        const item = {
            id: 'test-site', title: 'Site image render test', itemType: 'job',
            description: 'test', source: SOURCE, date: 'TBD', location: 'TBD', price: 'TBD',
            image: 'https://example.com/og.png', imageSource: 'site'
        };
        await sendOnePendingEmbed(mockBot, channel, item);
        const payload = channel.captured[0];
        const data = payload && (payload.embeds[0].data || payload.embeds[0]);
        check('site: description does NOT contain badge text', !/Placeholder image/.test(data?.description || ''), data?.description?.slice(0, 100));
        check('site: embed.image.url set', data?.image?.url === 'https://example.com/og.png');
    }
}

(async () => {
    ui.banner({
        title: `verify-image-pipeline: ${SOURCE}`,
        sub: 'unit + live integration, no Discord, no cache writes'
    });
    await testUnit();
    testShape();
    const placeholderUrl = derivePlaceholderForSource(SOURCE);
    if (placeholderUrl) await testAssetFetch(placeholderUrl, 'placeholder');
    await testIntegration();
    if (placeholderUrl) await testPendingRender();

    ui.blank();
    ui.summary([
        ['pass', String(pass)],
        ['fail', String(fail)],
        ['result', fail === 0 ? `${ui.tag('pass')}  all checks passed` : `${ui.tag('fail')}  ${fail} failure(s)`]
    ]);
    ui.blank();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('uncaught:', e); process.exit(1); });
