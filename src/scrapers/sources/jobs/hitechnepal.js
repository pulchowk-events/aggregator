// Source plugin: hitechnepal (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/hitechnepal.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "hitechnepal",
    type: "jobs",
    scrape: (ctx) => runSource("hitechnepal", "jobs", ctx)
};
