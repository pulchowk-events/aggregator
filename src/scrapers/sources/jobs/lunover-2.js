// Source plugin: lunover-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/lunover-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'lunover-2',
    type: 'jobs',
    scrape: (ctx) => runSource('lunover-2', 'jobs', ctx)
};
