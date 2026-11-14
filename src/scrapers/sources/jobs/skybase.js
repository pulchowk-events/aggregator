// Source plugin: skybase (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/skybase.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "skybase",
    type: "jobs",
    scrape: (ctx) => runSource("skybase", "jobs", ctx)
};
