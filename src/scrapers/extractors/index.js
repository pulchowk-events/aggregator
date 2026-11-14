// src/scrapers/extractors/index.js
// Loader for extractor modules.
//
// For a given (type, name), returns { extractor, isStub }.
// Extractor files are committed, one per source, at `./<type>/<name>.js`.
//
// `isStub` is retained in the return shape for callers that already branch
// on it; a real extractor always sets it false, and the loader no longer
// resolves a separate stub file.
//
// Results are cached in-process so repeated scrapes don't re-require.

const path = require('path');

const cache = new Map();

function loadExtractor(type, name) {
    const key = `${type}/${name}`;
    if (cache.has(key)) return cache.get(key);

    const realPath = path.join(__dirname, type, name);

    let extractor;
    try {
        extractor = require(realPath);
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            throw new Error(`No extractor for ${key}: ${realPath}.js does not exist`);
        }
        // Extractor file exists but has a syntax/require error — hard
        // failure, surface the underlying message.
        throw new Error(`Extractor ${key} failed to load: ${error.message}`);
    }

    if (!extractor || typeof extractor.extract !== 'function') {
        throw new Error(`Extractor ${key} does not export an extract() function`);
    }

    // isStub retained in the return shape for existing callers
    // (_orchestrate, diagnose, verify). A real extractor is never a stub;
    // the .example.js fallback that used to set this true was removed.
    const result = { extractor, isStub: false };
    cache.set(key, result);
    return result;
}

module.exports = { loadExtractor };
