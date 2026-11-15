// Source plugin: evolveasia-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/evolveasia-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'evolveasia-2',
    type: 'jobs',
    scrape: (ctx) => runSource('evolveasia-2', 'jobs', ctx)
};
