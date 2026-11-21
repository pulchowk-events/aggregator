// Source plugin: lftechnology-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/lftechnology-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'lftechnology-2',
    type: 'jobs',
    scrape: (ctx) => runSource('lftechnology-2', 'jobs', ctx)
};
