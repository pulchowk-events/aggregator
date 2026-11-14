// Source plugin: dishhome (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/dishhome.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "dishhome",
    type: "jobs",
    scrape: (ctx) => runSource("dishhome", "jobs", ctx)
};
