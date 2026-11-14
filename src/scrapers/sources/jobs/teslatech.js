// Source plugin: teslatech (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/teslatech.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "teslatech",
    type: "jobs",
    scrape: (ctx) => runSource("teslatech", "jobs", ctx)
};
