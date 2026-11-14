// Source plugin: tech101 (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/tech101.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "tech101",
    type: "jobs",
    scrape: (ctx) => runSource("tech101", "jobs", ctx)
};
