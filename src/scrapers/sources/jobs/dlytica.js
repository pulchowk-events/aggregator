// Source plugin: dlytica (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/dlytica.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "dlytica",
    type: "jobs",
    scrape: (ctx) => runSource("dlytica", "jobs", ctx)
};
