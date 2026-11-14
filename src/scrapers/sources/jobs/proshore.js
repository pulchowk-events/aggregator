// Source plugin: proshore (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/proshore.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "proshore",
    type: "jobs",
    scrape: (ctx) => runSource("proshore", "jobs", ctx)
};
