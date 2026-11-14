// Re-export shim. The message catalogue moved to src/core/messages.js
// so bot phases (posting/, integrations/) can use the same human-readable
// labels as the batch pipeline. Every existing require still works.
module.exports = require("../../../src/core/messages");
