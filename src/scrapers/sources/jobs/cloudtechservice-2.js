// Source plugin: cloudtechservice-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/cloudtechservice-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'cloudtechservice-2',
    type: 'jobs',
    scrape: (ctx) => runSource('cloudtechservice-2', 'jobs', ctx)
};
