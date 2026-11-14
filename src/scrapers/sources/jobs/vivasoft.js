// Source plugin: vivasoft (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/vivasoft.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "vivasoft",
    type: "jobs",
    scrape: (ctx) => runSource("vivasoft", "jobs", ctx)
};
