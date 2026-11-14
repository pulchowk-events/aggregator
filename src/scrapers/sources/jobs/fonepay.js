// Source plugin: fonepay (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/fonepay.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "fonepay",
    type: "jobs",
    scrape: (ctx) => runSource("fonepay", "jobs", ctx)
};
