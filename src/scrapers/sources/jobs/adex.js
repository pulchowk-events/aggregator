// Source plugin: adex (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/adex.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "adex",
    type: "jobs",
    scrape: (ctx) => runSource("adex", "jobs", ctx)
};
