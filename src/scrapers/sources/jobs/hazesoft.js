// Source plugin: hazesoft (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/hazesoft.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "hazesoft",
    type: "jobs",
    scrape: (ctx) => runSource("hazesoft", "jobs", ctx)
};
