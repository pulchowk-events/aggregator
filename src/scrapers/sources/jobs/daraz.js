// Source plugin: daraz (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/daraz.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "daraz",
    type: "jobs",
    scrape: (ctx) => runSource("daraz", "jobs", ctx)
};
