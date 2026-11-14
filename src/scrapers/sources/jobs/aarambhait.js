// Source plugin: aarambhait (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/aarambhait.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "aarambhait",
    type: "jobs",
    scrape: (ctx) => runSource("aarambhait", "jobs", ctx)
};
