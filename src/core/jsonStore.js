'use strict';
const fs = require('fs');
const path = require('path');

// Atomic JSON write: tmp file + rename; creates parent dirs. Callers keep their own read/corrupt-file policy.
function writeJsonAtomic(file, data, { newline = false, mode, indent = 2 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const text = JSON.stringify(data, null, indent) + (newline ? '\n' : '');
    if (mode === undefined) fs.writeFileSync(tmp, text); else fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
}

module.exports = { writeJsonAtomic };
