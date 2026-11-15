#!/usr/bin/env node
// scripts/test-discord-send.js
//
// Discord embed smoke tester. Uses a webhook (never bot login) so it's
// safe to run while the prod bot is live, and touches no cache, markers,
// or env. One message per run.
//
// Modes:
//   --dry                          fake item, print JSON, exit fast (<1s)
//   --source <name>                scrape <name>, send via webhook
//   --source <name> --dry          scrape <name>, print JSON, exit
//   --image <url>                  direct image URL, send via webhook
//   --image <url> --dry            direct image URL, print JSON
//
// Long-term: every future component test (sanitization, posting,
// full-pipeline) sends via the same webhook + same buildEmbed helper,
// so visuals are verifiable by a human looking at one channel.
//
// Setup (one time, in a Discord test channel):
//   1. Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy URL
//   2. echo '<url>' > data/test-webhook.txt   (gitignored, stays local)
//   or pass --webhook <url> per-run
//
// Kill the terminal quiet spell: --dry --source scrapes first (~15s);
// --dry --image or plain --dry are instant (no network).

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, WebhookClient } = require('discord.js');
const ui = require('../src/core/ui');

const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SOURCE     = getArg('--source');
const IMAGE_URL  = getArg('--image');
const WEBHOOK    = getArg('--webhook');
const DRY        = argv.includes('--dry');
const MODE       = getArg('--mode') || 'diagnostic';  // 'diagnostic' | 'live'

if (!['diagnostic', 'live'].includes(MODE)) {
    ui.line(`unknown --mode '${MODE}' (expected: diagnostic | live)`);
    process.exit(1);
}

if (!SOURCE && !IMAGE_URL && !DRY) {
    ui.line('Usage:');
    ui.line('  node scripts/test-discord-send.js --dry                    (fake item, print JSON, no network)');
    ui.line('  node scripts/test-discord-send.js --image <url> [--dry]     (direct URL test)');
    ui.line('  node scripts/test-discord-send.js --source <name> [--dry]   (scrape then send/dry)');
    ui.line('Optional: --webhook <url>  (overrides data/test-webhook.txt)');
    process.exit(1);
}

function readWebhook() {
    if (WEBHOOK) return WEBHOOK.trim();
    const p = path.resolve(__dirname, '..', 'data', 'test-webhook.txt');
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').trim() || null;
}

function buildEmbed(item) {
    const embed = new EmbedBuilder()
        .setTitle(`Webhook test: ${(item.title || 'untitled').slice(0, 200)}`)
        .setDescription('One-off webhook smoke test. If the image below renders, Discord CDN can fetch the URL. No bot login, no cache writes.')
        .addFields(
            { name: 'Source',      value: item.source || 'unknown',    inline: true },
            { name: 'imageSource', value: item.imageSource || 'none',  inline: true },
            { name: 'Image URL',   value: '`' + (item.image || 'none').slice(0, 200) + '`', inline: false }
        )
        .setFooter({ text: `test-discord-send · ${new Date().toISOString()}` });
    if (item.image) embed.setImage(item.image);
    return embed;
}

// Live mode replicates what post.js actually sends: a markdown content
// string from buildPostContent(), plus the image as a file attachment
// (NOT embed.setImage -- production does not use embeds for jobs).
async function buildLivePayload(item) {
    const { buildPostContent } = require('../src/core/formatting');
    const content = buildPostContent(item, null);  // no ping mention in test
    const files = [];
    if (item.image) {
        try {
            const axios = require('axios');
            const res = await axios.get(item.image, { responseType: 'arraybuffer', timeout: 15000 });
            const { AttachmentBuilder } = require('discord.js');
            files.push(new AttachmentBuilder(Buffer.from(res.data), { name: 'event.jpg' }));
        } catch (e) {
            ui.line(`  warn: image fetch failed (${e.message}) -- sending text only`);
        }
    }
    return { content, files };
}

async function resolveItem() {
    if (IMAGE_URL) {
        return {
            title: 'Direct image test',
            source: 'direct-url',
            image: IMAGE_URL,
            imageSource: 'manual',
            itemType: 'job'
        };
    }
    if (SOURCE) {
        ui.line(`  scraper: running runSource('${SOURCE}', 'jobs')...`);
        const { withPage } = require('../src/scrapers/browser');
        const { runSource } = require('../src/scrapers/sources/_orchestrate');
        const { normalizeJobToEventShape } = require('../src/core/shape');
        const { items } = await runSource(SOURCE, 'jobs', { withPage, progress: null });
        const withImg = (items || []).find(i => i.image);
        if (!withImg) {
            ui.line(`  FAIL  no items with image returned for ${SOURCE}`);
            process.exit(1);
        }
        const item = normalizeJobToEventShape(withImg);
        ui.line(`  picked: "${(item.title || '').slice(0, 60)}"  imageSource=${item.imageSource || 'none'}`);
        return item;
    }
    // --dry with no source and no image: fake item
    return {
        title: 'Dry-run test item',
        source: 'fake',
        image: 'https://raw.githubusercontent.com/pulchowk-events/aggregator/main/assets/placeholders/vianet.png',
        imageSource: 'placeholder',
        itemType: 'job'
    };
}

(async () => {
    ui.banner({
        title: `test-discord-send${SOURCE ? ': ' + SOURCE : IMAGE_URL ? ': direct-url' : ': dry-only'}${DRY ? ' [dry]' : ''}`,
        sub: `${MODE} mode${DRY ? ' · dry (no send)' : ' · real send via webhook'}`
    });

    const item = await resolveItem();

    // Build the payload based on mode.
    let payload;
    if (MODE === 'live') {
        ui.line(`  mode: live -- markdown content + file attachment (matches post.js)`);
        payload = await buildLivePayload(item);
    } else {
        const embed = buildEmbed(item);
        payload = { embeds: [embed] };
    }

    if (DRY) {
        ui.line('');
        ui.line(`  --dry: ${MODE} payload (would be sent to webhook) --`);
        if (MODE === 'live') {
            const printable = {
                content: payload.content,
                fileCount: payload.files.length,
                fileSizes: payload.files.map(f => f.attachment ? f.attachment.length : 'unknown')
            };
            ui.line(JSON.stringify(printable, null, 2));
        } else {
            ui.line(JSON.stringify(payload.embeds[0].data, null, 2));
        }
        ui.line('');
        ui.line('  no send. drop --dry and configure data/test-webhook.txt to actually post.');
        return;
    }

    const webhookUrl = readWebhook();
    if (!webhookUrl) {
        ui.line('');
        ui.line('  FAIL  no webhook configured.');
        ui.line('  setup:');
        ui.line('    1. In any test channel: Edit Channel -> Integrations -> Webhooks -> New Webhook');
        ui.line('    2. echo "<webhook-url>" > data/test-webhook.txt');
        ui.line('    (data/ is gitignored; the URL stays local)');
        ui.line('  or pass one-off with --webhook <url>');
        process.exit(1);
    }

    const wh = new WebhookClient({ url: webhookUrl });
    try {
        const msg = await wh.send({
            ...payload,
            username: 'Pulchowk Events (test)',
            wait: true
        });
        ui.line('');
        ui.line(`  PASS  embed sent`);
        ui.line(`  message id: ${msg.id}`);
        ui.line('');
        ui.line('  check the test channel:');
        ui.line('    - title + description + 3 fields render?');
        ui.line(`    - image renders?  URL: ${(item.image || 'none').slice(0, 80)}${(item.image || '').length > 80 ? '...' : ''}`);
        ui.line('');
        ui.line('  if image blank:');
        ui.line(`    curl -sI "${item.image || ''}"  # expect 200 + image/* content-type`);
    } catch (e) {
        ui.line(`  FAIL  webhook send failed: ${e.message}`);
        process.exit(1);
    } finally {
        wh.destroy();
    }
})().then(async () => {
    // Clean exit: Chromium inherits stdout, so if we don't explicitly
    // close it the process (and any pipe like `| tail`) never sees EOF.
    // Race the browser close against a 2s timeout -- if closeBrowser
    // hangs, exit anyway rather than leave the terminal stuck.
    try {
        const browserMod = require('../src/scrapers/browser');
        if (typeof browserMod.closeBrowser === 'function') {
            await Promise.race([
                browserMod.closeBrowser().catch(() => {}),
                new Promise(r => setTimeout(r, 2000))
            ]);
        }
    } catch { /* ignore */ }
    process.exit(0);
}).catch(e => { console.error('uncaught:', e); process.exit(1); });
