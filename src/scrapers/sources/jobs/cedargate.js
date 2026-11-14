// Source plugin: cedargate (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/cedargate.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "cedargate",
    type: "jobs",
    scrape: (ctx) => runSource("cedargate", "jobs", ctx)
};
