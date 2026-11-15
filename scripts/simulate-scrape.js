#!/usr/bin/env node
// scripts/simulate-scrape.js
//
// Full-pipeline dry run. Runs runSource (geo -> itemFilter ->
// universalNormalize -> enrichment -> shape) for each source, classifies
// items against the current cache to determine what /scrape jobs would
// queue, then sends up to 2 sample posts per source to the webhook in
// production format so you can visually verify before running the real
// /scrape.
//
// Touches NOTHING persistent. Cache is read-only. No markers touched.
// No Discord bot login. Audit redirected to /tmp/audit-simulate.jsonl.
// Safe while -win prod bot is running.
//
// Usage:
//   node scripts/simulate-scrape.js                   (default 4 sources)
//   node scripts/simulate-scrape.js evolveasia,yarsalabs
//   node scripts/simulate-scrape.js --dry             (no webhook, print only)

process.env.AUDIT_FILE = '/tmp/audit-simulate.jsonl';
try { require('fs').truncateSync('/tmp/audit-simulate.jsonl', 0); } catch { /* fresh */ }

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { runSource } = require(path.join(REPO, 'src/scrapers/sources/_orchestrate'));
const { withPage } = require(path.join(REPO, 'src/scrapers/browser'));
const { normalizeJobToEventShape } = require(path.join(REPO, 'src/core/shape'));
const { buildPostContent } = require(path.join(REPO, 'src/core/formatting'));
const { getEventDedupKey } = require(path.join(REPO, 'src/posting/dedup'));
const ui = require(path.join(REPO, 'src/core/ui'));
const axios = require('axios');
const { WebhookClient, AttachmentBuilder } = require('discord.js');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const SOURCES = (() => {
    const pos = argv.find(a => !a.startsWith('-'));
    if (pos) return pos.split(',').map(s => s.trim()).filter(Boolean);
    return ['evolveasia', 'yarsalabs', 'vianet', 'aegishms'];
})();

function readWebhook() {
    const p = path.join(REPO, 'data', 'test-webhook.txt');
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, 'utf8').trim();
    return v || null;
}

function loadCacheKeys() {
    const cp = path.join(REPO, 'data', 'cache.json');
    if (!fs.existsSync(cp)) return { posted: new Set(), pending: new Set(), skipped: new Set() };
    const cache = JSON.parse(fs.readFileSync(cp, 'utf8'));
    const keySet = (arr) => new Set((arr || []).map(e => {
        try { return getEventDedupKey(e); } catch { return null; }
    }).filter(Boolean));
    return {
        posted: keySet(cache.postedEvents),
        pending: keySet(cache.pendingEvents),
        skipped: keySet(cache.skippedEvents)
    };
}

async function sendToWebhook(wh, item) {
    const content = buildPostContent(item, null);
    const files = [];
    if (item.image) {
        try {
            const r = await axios.get(item.image, { responseType: 'arraybuffer', timeout: 15000 });
            files.push(new AttachmentBuilder(Buffer.from(r.data), { name: 'event.jpg' }));
        } catch (e) {
            ui.line(`    (image fetch failed: ${e.message} -- text only)`);
        }
    }
    await wh.send({ content, files, username: 'Pulchowk Events (simulate)' });
    await new Promise(r => setTimeout(r, 500));
}

(async () => {
    ui.banner({
        title: `simulate-scrape: ${SOURCES.length} source(s)`,
        sub: `${DRY ? 'dry -- no webhook, print only' : 'webhook -- real Discord render'}` 
    });

    const whUrl = DRY ? null : readWebhook();
    if (!DRY && !whUrl) ui.line('no data/test-webhook.txt -- falling back to --dry');
    const wh = whUrl ? new WebhookClient({ url: whUrl }) : null;
    const cacheKeys = loadCacheKeys();
    ui.resultRow({
        tag: ui.tag('info'),
        name: 'cache',
        meta: `posted=${cacheKeys.posted.size} pending=${cacheKeys.pending.size} skipped=${cacheKeys.skipped.size}`
    }).forEach(l => ui.line(l));

    let totRaw = 0, totLayerDrops = 0, totPost = 0, totDedup = 0, totQueue = 0, totSent = 0;

    for (const src of SOURCES) {
        ui.blank();
        const t0 = Date.now();
        let result;
        try {
            result = await runSource(src, 'jobs', { withPage, progress: null });
        } catch (e) {
            ui.line(`  ${ui.tag('fail')} ${src}: ${e.message}`);
            continue;
        }
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        const items = result.items || [];
        const meta = result.meta || {};
        const layerDrops = (meta.locationDropped || 0) + (meta.descriptionDropped || 0) + (meta.expiredSkipped || 0);
        const extractorRaw = items.length + layerDrops;
        const shaped = items.map(normalizeJobToEventShape);

        const toQueue = [];
        let dedupedCount = 0;
        for (const it of shaped) {
            let key = null;
            try { key = getEventDedupKey(it); } catch { /* skip */ }
            if (!key) { toQueue.push(it); continue; }
            if (cacheKeys.posted.has(key) || cacheKeys.pending.has(key) || cacheKeys.skipped.has(key)) {
                dedupedCount++;
            } else {
                toQueue.push(it);
            }
        }

        totRaw += extractorRaw;
        totLayerDrops += layerDrops;
        totPost += items.length;
        totDedup += dedupedCount;
        totQueue += toQueue.length;

        ui.resultRow({
            tag: ui.tag(items.length === 0 ? 'skip' : 'pass'),
            name: src,
            meta: `raw=${extractorRaw} layer-drops=${layerDrops} post=${items.length} dedup=${dedupedCount} queue=${toQueue.length}`,
            right: `${dur}s`
        }).forEach(l => ui.line(l));

        const samples = toQueue.slice(0, 2);
        if (samples.length === 0) {
            ui.line('    (nothing to post)');
            continue;
        }

        if (wh) {
            ui.line(`  sending ${samples.length} sample(s) to webhook...`);
            for (const s of samples) {
                try {
                    await sendToWebhook(wh, s);
                    totSent++;
                    ui.line(`    ${ui.tag('pass')} ${s.title}`);
                } catch (e) {
                    ui.line(`    ${ui.tag('fail')} ${s.title}: ${e.message}`);
                }
            }
        } else {
            for (const s of samples) {
                ui.line(`  [sample] ${s.title}`);
                ui.line(`    desc:  ${JSON.stringify(String(s.description || '').slice(0, 140))}`);
                ui.line(`    image: ${s.image ? 'present' : 'null'}`);
                ui.line(`    applyBy: ${s.applicationEndsDate || s.date || 'null'}  openings: ${s.openings || 'null'}`);
            }
        }
    }

    if (wh) wh.destroy();

    ui.blank();
    ui.summary([
        ['sources', String(SOURCES.length)],
        ['raw', String(totRaw)],
        ['layer drops', String(totLayerDrops)],
        ['post-layer', String(totPost)],
        ['deduped', String(totDedup)],
        ['would queue', String(totQueue)],
        ['sent to webhook', String(totSent)]
    ]);
    ui.blank();
})().then(() => process.exit(0)).catch(e => { console.error('uncaught:', e); process.exit(1); });
