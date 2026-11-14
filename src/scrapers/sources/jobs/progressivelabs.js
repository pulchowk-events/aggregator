// Source plugin: progressivelabs (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/progressivelabs.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "progressivelabs",
    type: "jobs",
    scrape: (ctx) => runSource("progressivelabs", "jobs", ctx)
};
