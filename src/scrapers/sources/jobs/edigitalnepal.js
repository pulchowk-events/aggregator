// Source plugin: edigitalnepal (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/edigitalnepal.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "edigitalnepal",
    type: "jobs",
    scrape: (ctx) => runSource("edigitalnepal", "jobs", ctx)
};
