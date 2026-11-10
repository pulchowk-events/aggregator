// STUB — copy to nepvents.js and implement. See ../README.md.
module.exports = {
    // NepVents embeds a wall of text (detail table, socials, register
    // button) inside its description field. This hook strips the boilerplate
    // before the orchestrator applies common trim + sanitize.
    preprocessItem(item) {
        const { cleanNepVentsDescription } = require('../../text');
        if (item && item.description) {
            item.description = cleanNepVentsDescription(item.description);
        }
        return item;
    },
    async extract(/* page, { progress, meta } */) {
        throw new Error('EXTRACTOR_NOT_IMPLEMENTED: nepvents — see src/scrapers/extractors/README.md');
    }
};
