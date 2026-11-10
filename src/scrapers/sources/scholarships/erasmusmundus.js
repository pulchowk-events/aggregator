// Source plugin: erasmusmundus (scholarships).
// Thin wrapper — extraction lives in src/scrapers/extractors/scholarships/erasmusmundus.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'erasmusmundus',
    type: 'scholarships',
    scrape: (ctx) => runSource('erasmusmundus', 'scholarships', ctx)
};
