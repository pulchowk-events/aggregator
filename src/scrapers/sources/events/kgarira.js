// Source plugin: Kgarira (kgarira.com).
// Thin wrapper — extraction lives in the private extractor at
// src/scrapers/extractors/events/kgarira.js (gitignored; see extractors/README.md).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'kgarira',
    type: 'events',
    scrape: (ctx) => runSource('kgarira', 'events', ctx)
};
