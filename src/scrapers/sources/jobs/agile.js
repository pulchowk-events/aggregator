// Source plugin: agile (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/agile.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "agile",
    type: "jobs",
    scrape: (ctx) => runSource("agile", "jobs", ctx)
};
