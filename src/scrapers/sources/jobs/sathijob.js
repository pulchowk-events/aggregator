// Source plugin: sathijob (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/sathijob.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'sathijob',
    type: 'jobs',
    scrape: (ctx) => runSource('sathijob', 'jobs', ctx)
};
