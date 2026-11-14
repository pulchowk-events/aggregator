// Source plugin: neptechpal (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/neptechpal.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "neptechpal",
    type: "jobs",
    scrape: (ctx) => runSource("neptechpal", "jobs", ctx)
};
