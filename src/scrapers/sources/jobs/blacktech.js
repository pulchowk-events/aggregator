// Source plugin: blacktech (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/blacktech.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "blacktech",
    type: "jobs",
    scrape: (ctx) => runSource("blacktech", "jobs", ctx)
};
