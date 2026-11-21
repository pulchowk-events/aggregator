// Source plugin: nimble-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/nimble-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'nimble-2',
    type: 'jobs',
    scrape: (ctx) => runSource('nimble-2', 'jobs', ctx)
};
