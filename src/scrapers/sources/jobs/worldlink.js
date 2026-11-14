// Source plugin: worldlink (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/worldlink.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "worldlink",
    type: "jobs",
    scrape: (ctx) => runSource("worldlink", "jobs", ctx)
};
