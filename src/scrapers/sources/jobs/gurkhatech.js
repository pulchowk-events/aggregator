// Source plugin: gurkhatech (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/gurkhatech.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "gurkhatech",
    type: "jobs",
    scrape: (ctx) => runSource("gurkhatech", "jobs", ctx)
};
