// Source plugin: KataJaam (katajaam.com).
// Thin wrapper — extraction lives in the private extractor at
// src/scrapers/extractors/events/katajaam.js (gitignored; see extractors/README.md).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'katajaam',
    type: 'events',
    scrape: (ctx) => runSource('katajaam', 'events', ctx)
};
