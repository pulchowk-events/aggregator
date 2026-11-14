// Source plugin: aayulogic (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/aayulogic.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "aayulogic",
    type: "jobs",
    scrape: (ctx) => runSource("aayulogic", "jobs", ctx)
};
