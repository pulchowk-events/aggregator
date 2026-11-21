// Source plugin: verisk (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/verisk.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'verisk',
    type: 'jobs',
    scrape: (ctx) => runSource('verisk', 'jobs', ctx)
};
