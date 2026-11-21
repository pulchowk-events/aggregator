// Source plugin: ekbana-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/ekbana-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'ekbana-2',
    type: 'jobs',
    scrape: (ctx) => runSource('ekbana-2', 'jobs', ctx)
};
