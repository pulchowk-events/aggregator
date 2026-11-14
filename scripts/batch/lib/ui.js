// Re-export shim. The batch UI primitives moved to src/core/ui.js so
// every bot phase (scrapeAll, post, supabase, websiteSync) can use the
// same styles as the batch pipeline. This shim keeps every existing
// `require('./lib/ui')` in scripts/batch/* working with zero changes.
module.exports = require('../../../src/core/ui');
