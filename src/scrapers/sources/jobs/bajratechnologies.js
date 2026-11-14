// Source plugin: bajratechnologies (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/bajratechnologies.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "bajratechnologies",
    type: "jobs",
    scrape: (ctx) => runSource("bajratechnologies", "jobs", ctx)
};
