// Source plugin: intuji-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/intuji-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'intuji-2',
    type: 'jobs',
    scrape: (ctx) => runSource('intuji-2', 'jobs', ctx)
};
