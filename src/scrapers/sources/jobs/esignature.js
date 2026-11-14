// Source plugin: esignature (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/esignature.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "esignature",
    type: "jobs",
    scrape: (ctx) => runSource("esignature", "jobs", ctx)
};
