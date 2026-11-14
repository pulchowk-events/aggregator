// Source plugin: devfinity (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/devfinity.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "devfinity",
    type: "jobs",
    scrape: (ctx) => runSource("devfinity", "jobs", ctx)
};
