// Source plugin: yarsalabs (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/yarsalabs.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "yarsalabs",
    type: "jobs",
    scrape: (ctx) => runSource("yarsalabs", "jobs", ctx)
};
