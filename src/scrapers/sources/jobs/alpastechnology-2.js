// Source plugin: alpastechnology-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/alpastechnology-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'alpastechnology-2',
    type: 'jobs',
    scrape: (ctx) => runSource('alpastechnology-2', 'jobs', ctx)
};
