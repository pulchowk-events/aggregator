// Source plugin: evolveasia (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/evolveasia.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "evolveasia",
    type: "jobs",
    scrape: (ctx) => runSource("evolveasia", "jobs", ctx)
};
