// Source plugin: instagram (social).
// Thin wrapper -- extraction lives in src/scrapers/extractors/social/instagram.js.
// Opt-in: hidden from the registry unless IG_SOCIAL_ENABLED is truthy.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: 'instagram',
    type: 'social',
    scrape: (ctx) => runSource('instagram', 'social', ctx)
};
