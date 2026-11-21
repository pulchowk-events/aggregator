// Source plugin: itonics-innovation (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/itonics-innovation.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'itonics-innovation',
    type: 'jobs',
    scrape: (ctx) => runSource('itonics-innovation', 'jobs', ctx)
};
