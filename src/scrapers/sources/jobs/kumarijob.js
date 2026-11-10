// Source plugin: kumarijob (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/kumarijob.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'kumarijob',
    type: 'jobs',
    scrape: (ctx) => runSource('kumarijob', 'jobs', ctx)
};
