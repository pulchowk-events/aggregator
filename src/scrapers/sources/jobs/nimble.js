// Source plugin: nimble (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/nimble.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "nimble",
    type: "jobs",
    scrape: (ctx) => runSource("nimble", "jobs", ctx)
};
