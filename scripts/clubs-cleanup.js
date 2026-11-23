#!/usr/bin/env node
'use strict';
// Delete orphaned files in the club-posts bucket (files no club_posts row points at), then revalidate.
//   node scripts/clubs-cleanup.js            DRY RUN (default): lists what would be deleted
//   node scripts/clubs-cleanup.js --apply    real deletes: needs WEBSITE_CLUBS_SYNC_ENABLED and the host guard
// Guards: empty row set aborts, more than 50 percent orphans aborts, files younger than 6 hours are kept.
// Not wired to cron: the existing scheduler in websiteSync/index.js was not part of this session.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply') && !args.includes('--dry-run');
const truthy = (v) => v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());

process.env.WEBSITE_SYNC_DRY_RUN = apply ? 'false' : 'true';
const env = require(path.join(ROOT, 'src/config/env'));
env.WEBSITE_SYNC_DRY_RUN = apply ? false : true;
if (apply) {
    if (truthy(env.DEV_MODE) || truthy(process.env.DEV_MODE)) { console.error('STOP: DEV_MODE is set. Unset it for --apply.'); process.exit(1); }
    if (!truthy(env.WEBSITE_CLUBS_SYNC_ENABLED) && !truthy(process.env.WEBSITE_CLUBS_SYNC_ENABLED)) { console.error('STOP: WEBSITE_CLUBS_SYNC_ENABLED is not true.'); process.exit(1); }
} else {
    env.WEBSITE_CLUBS_SYNC_ENABLED = true;
}
const ops = require(path.join(ROOT, 'src/integrations/websiteSync/clubsOps'));
(async () => {
    console.log('mode: ' + (apply ? 'APPLY (real deletes)' : 'DRY RUN (nothing deleted)'));
    const r = await ops.cleanupOrphans();
    console.log('RESULT ' + JSON.stringify(r));
    if (r && (r.ok === false || r.aborted)) process.exitCode = 1;
})().catch((e) => { console.error('cleanup failed: ' + e.message); process.exit(1); });
