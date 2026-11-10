// Source plugin: merojob (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/merojob.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'merojob',
    type: 'jobs',
    scrape: (ctx) => runSource('merojob', 'jobs', ctx)
};
