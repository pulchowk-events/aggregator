// Source plugin: esignature-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/esignature-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'esignature-2',
    type: 'jobs',
    scrape: (ctx) => runSource('esignature-2', 'jobs', ctx)
};
