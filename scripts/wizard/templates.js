// scripts/wizard/templates.js
// File content templates. The wizard writes three files per invocation:
//   src/scrapers/sources/<type>/<name>.js          — thin wrapper (never changes)
//   src/scrapers/extractors/<type>/<name>.js       — stub for the human/LLM to fill
//   src/scrapers/extractors/<type>/<name>.md       — the LLM prompt

function sourceWrapper(name, type) {
    return `// Source plugin: ${name} (${type}).
// Thin wrapper — extraction lives in src/scrapers/extractors/${type}/${name}.js.
const { runSource } = require('../_orchestrate');

module.exports = {
    name: '${name}',
    type: '${type}',
    scrape: (ctx) => runSource('${name}', '${type}', ctx)
};
`;
}

function extractorStub(name, type, detected) {
    const evidence = JSON.stringify(detected.evidence, null, 2);
    const signals = JSON.stringify(detected.signals, null, 2);
    return `// Extractor: ${name} (${type}).
// Generated ${new Date().toISOString()} by scripts/wizard/index.js
//
// Site type: ${detected.type}
//
// Detected signals:
//   ${signals.split('\n').join('\n//   ')}
//
// Detection evidence:
//   ${evidence.split('\n').join('\n//   ')}
//
// REPLACE THIS STUB:
//
//   Option A — use the wizard's interactive flow:
//       node scripts/wizard/interactive.js <name> <type>
//     (or just re-run the wizard — it drops you into the menu automatically)
//
//   Option B — manually:
//       1. Open ${name}.md (the LLM prompt, in this directory)
//       2. Paste it into DeepSeek (https://chat.deepseek.com/)
//       3. Copy the code block from the response
//       4. Paste it over this whole file
//       5. Run: node scripts/verify-source.js <name>
//
// Required return shape: { items: [...], meta }
// The orchestrator handles: browser lifecycle, retry, common sanitization,
// image URL validation, and diagnostic classification. Do NOT duplicate
// that here.
//
// Available helpers (require from '../../'):
//   page.js       — delay(ms)
//   progress.js   — safeDiscovered(progress, n), safeUnitDone(progress)
//   selectors.js  — pickOne(page, [...], {label}), pickAll(page, [...])
//   diagnostics.js — detectPageState(page)  (block detection)
//   sanitize.js   — sanitizeScrapedEvent, sanitizeImageUrl  (if pre-sanitizing)
//   text.js       — trimDescriptionToLastSentence, cleanDescriptionText
//
// See src/scrapers/extractors/events/khalti.js (single-page cards),
// events/katajaam.js (listing-to-detail), events/nepvents.js (JSON-LD-first)
// for full working examples.

module.exports = {
    async extract(page, { progress, meta }) {
        throw new Error('EXTRACTOR_NOT_IMPLEMENTED: ${name} — implement extract() using the ${name}.md prompt.');
    }
};
`;
}

module.exports = { sourceWrapper, extractorStub };
