// Source plugin: vrittechnologies (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/vrittechnologies.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "vrittechnologies",
    type: "jobs",
    scrape: (ctx) => runSource("vrittechnologies", "jobs", ctx)
};
