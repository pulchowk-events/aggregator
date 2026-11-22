'use strict';
// Probe, not a unit test: runSource pushes every item through sanitizeScrapedEvent
// and applyItemFilters(item, type). Those were NOT visible when S2 was written.
// If this fails, the finding is about sanitize/itemFilter handling of type
// 'social' (fix in S3), not about the extractor.
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../src/scrapers/extractors/social/instagram.js');
const { sanitizeScrapedEvent } = require('../src/scrapers/sanitize');
const { applyItemFilters } = require('../src/scrapers/itemFilter');

test('a social item survives sanitize + itemFilter with its caption intact', () => {
    const tile = {
        code: 'De_uDW1Bcni', kind: 'reel', href: '/locus_ioe/reel/De_uDW1Bcni/',
        alt: 'ONLINE PROJECT EXHIBITION | LOCUS 2027 IS LIVE!\nGot a tech project? Register now.\n\n#LOCUS2027',
        thumbnailUrl: null, labels: [], iconKind: null, isPinned: false, domIndex: 0
    };
    const item = ext._internal.buildItemFromTile(tile, { club: 'locus_ioe', nowMs: Date.UTC(2026, 10, 22) });
    const caption = item.caption;
    assert.ok(caption);
    sanitizeScrapedEvent(item, { source: 'instagram' });
    const res = applyItemFilters(item, 'social');
    assert.ok(res && res.item, 'applyItemFilters dropped the social item');
    assert.equal(item.caption, caption, 'sanitize altered the caption');
    assert.equal(res.item.caption, caption, 'itemFilter altered the caption');
});
