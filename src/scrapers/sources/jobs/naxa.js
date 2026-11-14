// Source plugin: naxa (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/naxa.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "naxa",
    type: "jobs",
    scrape: (ctx) => runSource("naxa", "jobs", ctx)
};
