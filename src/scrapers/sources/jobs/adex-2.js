// Source plugin: adex-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/adex-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'adex-2',
    type: 'jobs',
    scrape: (ctx) => runSource('adex-2', 'jobs', ctx)
};
