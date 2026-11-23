#!/usr/bin/env node
'use strict';
// Idempotent backfill of data/instagram/posts.json into the website clubs feed.
//   node scripts/clubs-backfill.js            DRY RUN (default): nothing is written
//   node scripts/clubs-backfill.js --apply    real writes: needs WEBSITE_CLUBS_SYNC_ENABLED and the host guard
//   add --images to also re-host post images and avatars
// Clubs are synced first (FK), posts are single-row upserts (never pruned), one revalidation at the end.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply') && !args.includes('--dry-run');
const withImages = args.includes('--images');
const truthy = (v) => v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());

process.env.WEBSITE_SYNC_DRY_RUN = apply ? 'false' : 'true';
const env = require(path.join(ROOT, 'src/config/env'));
env.WEBSITE_SYNC_DRY_RUN = apply ? false : true;
if (apply) {
    if (truthy(env.DEV_MODE) || truthy(process.env.DEV_MODE)) { console.error('STOP: DEV_MODE is set. Unset it for --apply.'); process.exit(1); }
    if (!truthy(env.WEBSITE_CLUBS_SYNC_ENABLED) && !truthy(process.env.WEBSITE_CLUBS_SYNC_ENABLED)) { console.error('STOP: WEBSITE_CLUBS_SYNC_ENABLED is not true.'); process.exit(1); }
} else {
    env.WEBSITE_CLUBS_SYNC_ENABLED = true;
    if (!(env.WEBSITE_SUPABASE_URL && env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY)) {
        env.DEV_MODE = true; process.env.DEV_MODE = 'true';
        console.log('(no website supabase config: printing in DEV_MODE)');
    }
}
if (withImages) env.WEBSITE_CLUBS_IMAGES_ENABLED = true;

const images = require(path.join(ROOT, 'src/integrations/websiteSync/clubImages'));
const ops = require(path.join(ROOT, 'src/integrations/websiteSync/clubsOps'));
const { POSTS_FILE } = require(path.join(ROOT, 'src/posting/socialPaths'));

(async () => {
    if (apply) {
        const g = images.checkHost('clubs-backfill');
        if (g) { console.error('STOP: host guard refused. Set WEBSITE_CLUBS_CONFIRM_HOST=' + (g.host || '<host>') + ' to confirm this target.'); process.exit(1); }
    }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (e) { console.error('cannot read ' + POSTS_FILE + ': ' + e.message); process.exit(1); }
    const recs = ops.loadRecs(raw);
    if (!recs.length) { console.error('no posts found in ' + POSTS_FILE); process.exit(1); }
    let clubList = [];
    try { clubList = require(path.join(ROOT, 'src/posting/socialClubs')).clubsStore.list(); } catch (e) { /* names fall back to the post label */ }
    console.log('mode: ' + (apply ? 'APPLY (real writes)' : 'DRY RUN (nothing written)') + ' | images: ' + withImages + ' | posts: ' + recs.length);
    const out = await ops.backfill(recs, { clubList });
    console.log('RESULT ' + JSON.stringify({ aborted: out.aborted, clubs: out.clubsResult, posts: out.posts, dry: out.dry, failed: out.failed, skipped: out.skipped }));
    if (out.aborted || out.failed) process.exitCode = 1;
})().catch((e) => { console.error('backfill failed: ' + e.message); process.exit(1); });
