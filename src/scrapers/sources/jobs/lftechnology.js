// Source plugin: lftechnology (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/lftechnology.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "lftechnology",
    type: "jobs",
    scrape: (ctx) => runSource("lftechnology", "jobs", ctx)
};
