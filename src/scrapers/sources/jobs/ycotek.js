// Source plugin: ycotek (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/ycotek.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "ycotek",
    type: "jobs",
    scrape: (ctx) => runSource("ycotek", "jobs", ctx)
};
