// Source plugin: scholarshipsads (scholarships).
// Thin wrapper — extraction lives in src/scrapers/extractors/scholarships/scholarshipsads.js (gitignored).
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'scholarshipsads',
    type: 'scholarships',
    scrape: (ctx) => runSource('scholarshipsads', 'scholarships', ctx)
};
