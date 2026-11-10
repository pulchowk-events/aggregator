// Source plugin: Khalti events (events.khalti.com).
// Thin wrapper — extraction lives in the private extractor at
// src/scrapers/extractors/events/khalti.js (gitignored; see extractors/README.md).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'khalti',
    type: 'events',
    scrape: (ctx) => runSource('khalti', 'events', ctx)
};
