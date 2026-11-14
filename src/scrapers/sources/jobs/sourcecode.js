// Source plugin: sourcecode (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/sourcecode.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "sourcecode",
    type: "jobs",
    scrape: (ctx) => runSource("sourcecode", "jobs", ctx)
};
