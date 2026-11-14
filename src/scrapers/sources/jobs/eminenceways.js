// Source plugin: eminenceways (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/eminenceways.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "eminenceways",
    type: "jobs",
    scrape: (ctx) => runSource("eminenceways", "jobs", ctx)
};
