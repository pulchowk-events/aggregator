// Source plugin: aegishms (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/aegishms.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "aegishms",
    type: "jobs",
    scrape: (ctx) => runSource("aegishms", "jobs", ctx)
};
