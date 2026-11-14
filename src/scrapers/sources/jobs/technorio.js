// Source plugin: technorio (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/technorio.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "technorio",
    type: "jobs",
    scrape: (ctx) => runSource("technorio", "jobs", ctx)
};
