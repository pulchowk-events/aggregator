// Source plugin: cloco (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/cloco.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "cloco",
    type: "jobs",
    scrape: (ctx) => runSource("cloco", "jobs", ctx)
};
