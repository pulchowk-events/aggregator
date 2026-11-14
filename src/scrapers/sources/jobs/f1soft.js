// Source plugin: f1soft (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/f1soft.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "f1soft",
    type: "jobs",
    scrape: (ctx) => runSource("f1soft", "jobs", ctx)
};
