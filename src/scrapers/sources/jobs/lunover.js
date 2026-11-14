// Source plugin: lunover (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/lunover.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "lunover",
    type: "jobs",
    scrape: (ctx) => runSource("lunover", "jobs", ctx)
};
