// Source plugin: infodev (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/infodev.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "infodev",
    type: "jobs",
    scrape: (ctx) => runSource("infodev", "jobs", ctx)
};
