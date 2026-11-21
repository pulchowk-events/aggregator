// Source plugin: uxcam-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/uxcam-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'uxcam-2',
    type: 'jobs',
    scrape: (ctx) => runSource('uxcam-2', 'jobs', ctx)
};
