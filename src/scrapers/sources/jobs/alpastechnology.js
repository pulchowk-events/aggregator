// Source plugin: alpastechnology (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/alpastechnology.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "alpastechnology",
    type: "jobs",
    scrape: (ctx) => runSource("alpastechnology", "jobs", ctx)
};
