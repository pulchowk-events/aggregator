// Source plugin: dev (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/dev.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "dev",
    type: "jobs",
    scrape: (ctx) => runSource("dev", "jobs", ctx)
};
