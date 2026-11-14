// Source plugin: quickfoxconsulting (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/quickfoxconsulting.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "quickfoxconsulting",
    type: "jobs",
    scrape: (ctx) => runSource("quickfoxconsulting", "jobs", ctx)
};
