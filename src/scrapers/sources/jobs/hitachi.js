// Source plugin: hitachi (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/hitachi.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "hitachi",
    type: "jobs",
    scrape: (ctx) => runSource("hitachi", "jobs", ctx)
};
