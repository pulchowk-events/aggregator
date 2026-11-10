// Source plugin: internsathi (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/internsathi.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'internsathi',
    type: 'jobs',
    scrape: (ctx) => runSource('internsathi', 'jobs', ctx)
};
