// Source plugin: cloudfactory (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/cloudfactory.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "cloudfactory",
    type: "jobs",
    scrape: (ctx) => runSource("cloudfactory", "jobs", ctx)
};
