// Source plugin: bajratechnologies-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/bajratechnologies-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'bajratechnologies-2',
    type: 'jobs',
    scrape: (ctx) => runSource('bajratechnologies-2', 'jobs', ctx)
};
