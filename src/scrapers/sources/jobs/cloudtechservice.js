// Source plugin: cloudtechservice (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/cloudtechservice.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "cloudtechservice",
    type: "jobs",
    scrape: (ctx) => runSource("cloudtechservice", "jobs", ctx)
};
