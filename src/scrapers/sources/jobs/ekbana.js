// Source plugin: ekbana (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/ekbana.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "ekbana",
    type: "jobs",
    scrape: (ctx) => runSource("ekbana", "jobs", ctx)
};
