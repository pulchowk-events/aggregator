// Source plugin: docsumo (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/docsumo.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "docsumo",
    type: "jobs",
    scrape: (ctx) => runSource("docsumo", "jobs", ctx)
};
