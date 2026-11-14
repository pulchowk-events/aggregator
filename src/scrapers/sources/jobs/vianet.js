// Source plugin: vianet (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/vianet.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "vianet",
    type: "jobs",
    scrape: (ctx) => runSource("vianet", "jobs", ctx)
};
