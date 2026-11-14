// scripts/batch/lib/audit.js
// Append-only decision log for batch runs. Per-run file at
// data/batch/<run>/audit.jsonl. Newline-delimited JSON, one entry per
// decision. Same spirit as src/core/auditLogger.js (the bot's audit
// surface), but batch-scoped: kept inside the run directory so inspecting
// a run means reading one file, not searching the bot's 8000-line log.
//
// Schema per entry:
//   { ts, phase, event, name, url, decision, reason, data }
//     ts       -- ISO8601 UTC
//     phase    -- 'discover'|'resolve'|'classify'|'generate'|'paste'|'verify'|'report'
//     event    -- 'url-accept'|'url-reject'|'url-follow'|'classify-result'|
//                 'ats-render'|'wizard-prompt'|'llm-write'|'verify-pass'|
//                 'verify-fail'|'skip'|'collision'
//     name     -- batch-derived source name (or null pre-classify)
//     url      -- requested URL (or resolved target URL after follow)
//     decision -- short verb ('accept'|'reject'|'follow'|'pass'|'fail'|...)
//     reason   -- one-line human explanation
//     data     -- optional structured payload for debugging (pageShape,
//                 verdict, counts, etc.)
//
// Append-only. Never rewritten, never truncated. A run with 76 URLs
// produces ~150-300 entries, so the file is small (<100 KB) -- no
// rotation needed. Deleted with the run directory.
//
// If audit writes fail, throws. Callers should let that surface -- losing
// audit is worse than losing a batch.

const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

function writeAudit(runDir, entry) {
    const p = paths(runDir);
    const record = {
        ts: new Date().toISOString(),
        ...entry
    };
    // Ensure directory exists (idempotent). A batch run mid-crash may
    // have partially created dirs; we don't want the write to fail for
    // that reason.
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(path.join(runDir, 'audit.jsonl'), JSON.stringify(record) + '\n');
}

// Convenience wrappers per phase. Each returns undefined; failures throw.
const audit = {
    resolveAccept: (runDir, { name, url, targetUrl, pageShape, reasoning }) =>
        writeAudit(runDir, { phase: 'resolve', event: 'url-accept', name, url, decision: 'accept', reason: reasoning, data: { targetUrl, pageShape } }),

    resolveReject: (runDir, { name, url, pageShape, reasoning, chain }) =>
        writeAudit(runDir, { phase: 'resolve', event: 'url-reject', name, url, decision: 'reject', reason: reasoning, data: { pageShape, chain } }),

    resolveFollow: (runDir, { url, targetUrl, reasoning }) =>
        writeAudit(runDir, { phase: 'resolve', event: 'url-follow', url, decision: 'follow', reason: reasoning, data: { targetUrl } }),

    classifyResult: (runDir, { name, url, classType, template, slug, reasoning }) =>
        writeAudit(runDir, { phase: 'classify', event: 'classify-result', name, url, decision: classType, reason: reasoning, data: { template, slug } }),

    atsRender: (runDir, { name, template, ok, error }) =>
        writeAudit(runDir, { phase: 'generate', event: 'ats-render', name, decision: ok ? 'ok' : 'fail', reason: ok ? `${template} template rendered` : error, data: { template } }),

    wizardPrompt: (runDir, { name, url, siteType, ok, error }) =>
        writeAudit(runDir, { phase: 'generate', event: 'wizard-prompt', name, url, decision: ok ? 'ok' : 'fail', reason: ok ? `prompt written (site type: ${siteType})` : error, data: { siteType } }),

    llmWrite: (runDir, { name, lineCount, bytes }) =>
        writeAudit(runDir, { phase: 'paste', event: 'llm-write', name, decision: 'ok', reason: `wrote ${lineCount} lines (${bytes} bytes)`, data: { lineCount, bytes } }),

    verifyPass: (runDir, { name, template, verdict, items, durationSec }) =>
        writeAudit(runDir, { phase: 'verify', event: 'verify-pass', name, decision: 'pass', reason: `${verdict} (${items} items, ${durationSec}s)`, data: { template, verdict, items, durationSec } }),

    verifyFail: (runDir, { name, template, verdict, items, reason, durationSec }) =>
        writeAudit(runDir, { phase: 'verify', event: 'verify-fail', name, decision: 'fail', reason: `${verdict || 'unknown'}: ${reason}`, data: { template, verdict, items, reason, durationSec } }),

    skip: (runDir, { phase, name, url, reason }) =>
        writeAudit(runDir, { phase, event: 'skip', name, url, decision: 'skip', reason }),

    collision: (runDir, { name, baseName, url }) =>
        writeAudit(runDir, { phase: 'classify', event: 'collision', name, url, decision: 'renamed', reason: `base name "${baseName}" was taken; using "${name}"`, data: { baseName } })
};

// Read all entries for a run. Returns array (possibly empty). Never throws
// -- returns [] if file missing or unparseable line found (with a warning).
function readAudit(runDir) {
    const p = path.join(runDir, 'audit.jsonl');
    if (!fs.existsSync(p)) return [];
    const out = [];
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch (e) { /* skip malformed */ }
    }
    return out;
}

module.exports = { audit, readAudit };
