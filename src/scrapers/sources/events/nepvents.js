// Source plugin: NepVents (nepvents.com).
// Thin wrapper — extraction lives in the private extractor at
// src/scrapers/extractors/events/nepvents.js (gitignored; see extractors/README.md).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'nepvents',
    type: 'events',
    scrape: (ctx) => runSource('nepvents', 'events', ctx)
};
