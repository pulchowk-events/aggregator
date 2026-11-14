// Source plugin: growbydata (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/growbydata.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "growbydata",
    type: "jobs",
    scrape: (ctx) => runSource("growbydata", "jobs", ctx)
};
