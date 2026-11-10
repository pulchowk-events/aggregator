// src/scrapers/extractors/index.js
// Loader for extractor modules.
//
// For a given (type, name), returns { extractor, isStub }:
//   - try `./<type>/<name>` first (real extractor, gitignored)
//   - on MODULE_NOT_FOUND, fall back to `./<type>/<name>.example`
//     (committed stub, throws on extract())
//
// The orchestrator uses `isStub` to short-circuit "not implemented" without
// ever invoking the stub — the stub's throw() is only a belt-and-suspenders
// for callers that bypass the loader.
//
// Results are cached in-process so repeated scrapes don't re-require.

const path = require('path');

const cache = new Map();

function loadExtractor(type, name) {
    const key = `${type}/${name}`;
    if (cache.has(key)) return cache.get(key);

    const realPath = path.join(__dirname, type, name);
    const examplePath = path.join(__dirname, type, `${name}.example`);

    let extractor;
    let isStub = false;

    try {
        extractor = require(realPath);
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') {
            // Real extractor exists but has a syntax/require error — this
            // is a hard failure, don't silently fall back to the stub.
            throw new Error(`Extractor ${key} failed to load: ${error.message}`);
        }
        try {
            extractor = require(examplePath);
            isStub = true;
        } catch (error2) {
            throw new Error(`No extractor for ${key}: neither ${realPath}.js nor ${examplePath}.js exist`);
        }
    }

    if (!extractor || typeof extractor.extract !== 'function') {
        throw new Error(`Extractor ${key} does not export an extract() function`);
    }

    const result = { extractor, isStub };
    cache.set(key, result);
    return result;
}

module.exports = { loadExtractor };
