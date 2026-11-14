// Source plugin: manaram (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/manaram.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "manaram",
    type: "jobs",
    scrape: (ctx) => runSource("manaram", "jobs", ctx)
};
