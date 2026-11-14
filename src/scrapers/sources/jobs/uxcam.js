// Source plugin: uxcam (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/uxcam.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "uxcam",
    type: "jobs",
    scrape: (ctx) => runSource("uxcam", "jobs", ctx)
};
