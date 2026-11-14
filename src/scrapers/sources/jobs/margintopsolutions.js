// Source plugin: margintopsolutions (jobs).
// Thin wrapper -- extraction lives in src/scrapers/extractors/jobs/margintopsolutions.js.
const { runSource } = require("../_orchestrate");

module.exports = {
    name: "margintopsolutions",
    type: "jobs",
    scrape: (ctx) => runSource("margintopsolutions", "jobs", ctx)
};
