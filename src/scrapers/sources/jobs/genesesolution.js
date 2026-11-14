// Source plugin: genesesolution (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/genesesolution.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "genesesolution",
    type: "jobs",
    scrape: (ctx) => runSource("genesesolution", "jobs", ctx)
};
