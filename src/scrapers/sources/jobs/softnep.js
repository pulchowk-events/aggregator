// Source plugin: softnep (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/softnep.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "softnep",
    type: "jobs",
    scrape: (ctx) => runSource("softnep", "jobs", ctx)
};
