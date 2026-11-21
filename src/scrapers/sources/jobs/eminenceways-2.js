// Source plugin: eminenceways-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/eminenceways-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'eminenceways-2',
    type: 'jobs',
    scrape: (ctx) => runSource('eminenceways-2', 'jobs', ctx)
};
