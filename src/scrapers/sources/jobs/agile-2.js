// Source plugin: agile-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/agile-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'agile-2',
    type: 'jobs',
    scrape: (ctx) => runSource('agile-2', 'jobs', ctx)
};
