// Source plugin: intuji (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/intuji.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "intuji",
    type: "jobs",
    scrape: (ctx) => runSource("intuji", "jobs", ctx)
};
