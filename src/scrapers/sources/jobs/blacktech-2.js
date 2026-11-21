// Source plugin: blacktech-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/blacktech-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'blacktech-2',
    type: 'jobs',
    scrape: (ctx) => runSource('blacktech-2', 'jobs', ctx)
};
