// Source plugin: vivekahealth (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/vivekahealth.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "vivekahealth",
    type: "jobs",
    scrape: (ctx) => runSource("vivekahealth", "jobs", ctx)
};
