// Source plugin: ycotek-2 (jobs).
// Thin wrapper — extraction lives in src/scrapers/extractors/jobs/ycotek-2.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'ycotek-2',
    type: 'jobs',
    scrape: (ctx) => runSource('ycotek-2', 'jobs', ctx)
};
