// Source plugin: sussol (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/sussol.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "sussol",
    type: "jobs",
    scrape: (ctx) => runSource("sussol", "jobs", ctx)
};
