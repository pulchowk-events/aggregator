// scripts/test/gates.junk.test.js
// Junk-title gate: predicate tables + post.js LIVE-branch integration.
// ASCII-only source: special characters are written as {EN} {EM} {ZW}
// tokens and expanded by x() below.
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Patch the audit logger and devMode BEFORE post.js loads. post.js
// destructures auditLog at require time and calls devMode.noteBlocked via
// the module object on every call. The postEventToCategory wrapper
// short-circuits mode=main under DEV_MODE BEFORE the gate chain, so the junk
// gate is unreachable while DEV_MODE=true; the integration test simulates
// DEV_MODE off by stubbing noteBlocked. Nothing here touches Discord, marker
// files or the real audit log (every refusal returns before reserve).
const auditLogger = require('../../src/core/auditLogger');
const devMode = require('../../src/core/devMode');
const realAuditLog = auditLogger.auditLog;
const realNoteBlocked = devMode.noteBlocked;
const auditCalls = [];
auditLogger.auditLog = function () { auditCalls.push(Array.prototype.slice.call(arguments)); };

const { getJunkTitleReason, hasJunkTitle } = require('../../src/posting/gates');
const { postEventToCategory } = require('../../src/posting/post');

after(() => {
    auditLogger.auditLog = realAuditLog;
    devMode.noteBlocked = realNoteBlocked;
});

const SPECIAL = {
    '{EN}': String.fromCharCode(0x2013),
    '{EM}': String.fromCharCode(0x2014),
    '{ZW}': String.fromCharCode(0x200B)
};
function x(s) {
    if (s === null || s === undefined) return s;
    return String(s).replace(/\{EN\}|\{EM\}|\{ZW\}/g, (m) => SPECIAL[m]);
}
const DEVA_SUCHANA = String.fromCharCode(0x0938, 0x0942, 0x091A, 0x0928, 0x093E); // 5 code points, 3 base letters
const DEVA_BHOJ = String.fromCharCode(0x092D, 0x094B, 0x091C); // 3 code points, 2 base letters

// [title, itemType, expected rule]
const REJECTS = [
    [null, 'job', 'empty_title'],
    ['', 'job', 'empty_title'],
    ['{ZW}', 'job', 'empty_title'],
    ['-', 'event', 'too_short'],
    ['ab', 'event', 'too_short'],
    ['2026', 'event', 'no_letters'],
    ['Untitled Job', 'job', 'placeholder'],
    ['Untitled Internship', 'job', 'placeholder'],
    ['Untitled Event', 'event', 'placeholder'],
    ['Untitled.', 'event', 'placeholder'],
    ['Sorry, there are no positions available at this time.', 'job', 'empty_state'],
    ['No open positions', 'job', 'empty_state'],
    ['Home', 'event', 'nav_heading'],
    ['About Us', 'event', 'nav_heading'],
    ['ABOUT', 'job', 'nav_heading'],
    ['CONTENT', 'job', 'allcaps_single'],
    ['MANAGEMENT', 'job', 'allcaps_single'],
    ['FINANCE', 'job', 'allcaps_single'],
    ['{ZW}FINANCE', 'job', 'allcaps_single'],
    ["Gurkha Tech's internships page", 'job', 'nav_suffix'],
    ['internship projects Blog', 'job', 'nav_suffix'],
    ['International travel opportunities', 'job', 'nav_suffix'],
    ['Nightlife Events in Kathmandu', undefined, 'listing_page'],
    ['Food & Drink Events in Kathmandu', undefined, 'listing_page'],
    ['Art & Exhibition Events in Kathmandu', undefined, 'listing_page']
];

// Real titles from the audit-log inventory (29 of the 30; the 30th,
// "Art & Exhibition Events in Kathmandu", is a katajaam listing page and
// lives in REJECTS) plus false-positive hazards.
const ACCEPTS = [
    ['15th European Union Film Festival Nepal 2026', 'event'],
    ['2-Day Hand Embroidery Workshop at Manjari', 'event'],
    ['2-Week Databricks data & AI Bootcamp 2026', 'event'],
    ['5th National Ghar Nirman Fest 2083', 'event'],
    ['7th Annual Nepal AI School (ANAIS)', 'event'],
    ['AI Enablement Lead', 'job'],
    ['AI Integration Engineer', 'job'],
    ['AI/ML ENGINEER {EN} KATHMANDU', 'job'],
    ['AIDA Impact Challenge 2026', 'event'],
    ['AWS Cloud Foundations to Production-Ready Architecture: 3-Day Hands-on Bootcamp', 'event'],
    ['AWS Student Community Day Kathmandu 2026', 'event'],
    ['AWS Student Community Dhulikhel 2026', 'event'],
    ['Account Officer', 'job'],
    ['Agents of Change: Buildathon', 'event'],
    ["Anong Strides {EN} Stride 8: Thursday Women's Run", 'event'],
    ['Architectural and Urban Contemporary Heritage', 'event'],
    ['Arthur Gunn Live in Nepal', 'event'],
    ['Artificial Intelligence Olympiad of Nepal', 'event'],
    ['Assistant Manager {EN} Business Development (Insurance & Health)', 'job'],
    ['Atif Aslam Live in Nepal: Subah Aye Na Tour', 'event'],
    ['Australia Awards Scholarships 2027 for International Students | Fully Funded', 'scholarship'],
    ['BSides Kathmandu', 'event'],
    ['Backend Developer', 'job'],
    ["Baddies Run 2026: Women's 5K in Jawalakhel", 'event'],
    ['Banepa Heritage Walk', 'event'],
    ['Beijing Government Scholarship 2027, China (Fully Funded)', 'scholarship'],
    ['Beyond the Brush: Paubha Talk & Dapha Bhajan (Abhyasa Exhibition Closing) at Patan Museum', 'event'],
    ['Bipul Chettri Pravah Nepal Tour (Kathmandu)', 'event'],
    ['Bollywood Night at Hot Topic, Lazimpat', 'event'],
    // hazards named in the brief and seen in the audit log
    ['Programiz is hiring Programming Content Writer Interns!', 'job'],
    ['Digital Content Writer', 'job'],
    ['Digital Marketing Expert- Required Position', 'job'],
    ['Frontend Developer [Intern]', 'job'],
    ['{ZW}Customer Success Executive', 'job'],
    ['CLIENT STRATEGIST, SEARCH & MARKET INTELLIGENCE {EN} BOSTON MA', 'job'],
    ['HEAD OF PRODUCT ENGINEERING', 'job'],
    ['SEO ANALYST', 'job'],
    ['Receptionist', 'job'],
    ['HunterHood', 'event'],
    ['FULBRIGHT', 'scholarship'],
    ['OCTAVE', 'event'],
    ['Untitled: A Solo Show', 'event'],
    ['About the Role', 'job'],
    ['Internship Projects Coordinator', 'job'],
    ['Homepage Redesign Lead', 'job'],
    ['Laksh Maheshwari {EM} "Khushiyan Lekar Aaya Hai" (A Storytelling Special)', 'event'],
    [DEVA_SUCHANA, 'event'],
    [DEVA_BHOJ, 'event'],
    // KNOWN GAPS, not gated by design (source-block fixes): a real
    // "Bootcamp Instructor" job makes a bare "Bootcamp" rule unsafe, and
    // "Internship Opportunities at ..." can be a real posting heading.
    ['Proshore Bootcamp', 'job'],
    ['Internship Opportunities at Gurkha Technology', 'job']
];

function makeBot(settings) {
    const base = {
        cache: { settings: settings || {}, pendingEvents: [] },
        saveCache() {},
        // post.js returns no_category unless CATEGORIES[key] exists; the Proxy
        // fallback would otherwise hand back a truthy function for CATEGORIES.
        CATEGORIES: { jobs: { main: 'test-main-jobs', test: 'test-test-jobs' } },
        sendLogMessage: async () => undefined,
        // post.js resolves the category before the gate chain runs.
        determineCategory() { return 'jobs'; }
    };
    // Any other bot helper the pre-gate code touches becomes a harmless no-op.
    return new Proxy(base, {
        get(t, p) {
            if (p in t) return t[p];
            if (typeof p === 'symbol' || p === 'then') return undefined;
            return () => undefined;
        }
    });
}
function junkRows() { return auditCalls.filter((c) => c[0] === 'junk_title'); }

test('junk gate: rejects table returns the expected rule code', () => {
    for (const [title, itemType, rule] of REJECTS) {
        assert.equal(
            getJunkTitleReason({ title: x(title), itemType }, {}),
            rule,
            'expected ' + rule + ' for ' + JSON.stringify(x(title)) + ' (' + itemType + ')'
        );
    }
});

test('junk gate: accepts table (real titles, hazards) and settings overrides', () => {
    for (const [title, itemType] of ACCEPTS) {
        assert.equal(
            getJunkTitleReason({ title: x(title), itemType }, {}),
            null,
            'must NOT be junk: ' + JSON.stringify(x(title)) + ' (' + itemType + ')'
        );
    }
    // null / missing inputs never throw
    assert.equal(getJunkTitleReason(null, {}), null);
    assert.equal(getJunkTitleReason({ title: 'Senior QA Engineer' }), null);
    // operator escape hatches
    assert.equal(getJunkTitleReason({ title: 'Home', itemType: 'event' }, { junkTitle: { allow: ['home'] } }), null);
    assert.equal(getJunkTitleReason({ title: 'CONTENT', itemType: 'job' }, { junkTitle: { allow: ['Content'] } }), null);
    assert.equal(getJunkTitleReason({ title: 'Untitled Job', itemType: 'job' }, { junkTitle: { enabled: false } }), null);
    // allow never rescues an empty title
    assert.equal(getJunkTitleReason({ title: '', itemType: 'job' }, { junkTitle: { allow: [''] } }), 'empty_title');
    // extraPatterns: valid one fires, invalid one is skipped without throwing
    const cfg = { junkTitle: { extraPatterns: ['(', '^Foo Bar$'] } };
    assert.equal(getJunkTitleReason({ title: 'Foo Bar', itemType: 'event' }, cfg), 'extra');
    assert.equal(getJunkTitleReason({ title: 'Baz Qux', itemType: 'event' }, cfg), null);
    // bot-bound wrapper reads bot.cache.settings
    assert.equal(hasJunkTitle(makeBot(), { title: 'Untitled Job', itemType: 'job' }), true);
    assert.equal(hasJunkTitle(makeBot({ junkTitle: { allow: ['Untitled Job'] } }), { title: 'Untitled Job', itemType: 'job' }), false);
    assert.equal(hasJunkTitle(null, { title: 'Senior QA Engineer', itemType: 'job' }), false);
});

test('postEventToCategory mode=main: junk title refused with reason junk_title', async () => {
    const bot = makeBot();
    const junk = { id: 'junk-1', title: 'Untitled Job', source: 'sathijob', itemType: 'job', category: 'jobs' };

    // (a) ordering: DEV_MODE short-circuits mode=main BEFORE the junk gate.
    devMode.noteBlocked = () => true;
    const blocked = await postEventToCategory(bot, junk, 'main');
    assert.equal(blocked.reason, 'dev_mode');
    assert.equal(junkRows().length, 0, 'junk gate must not run under DEV_MODE');

    // (b) DEV_MODE simulated off: the gate fires with the specific reason.
    devMode.noteBlocked = () => false;
    const r = await postEventToCategory(bot, junk, 'main');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'junk_title');
    assert.equal(r.junkRule, 'placeholder');

    // (c) audit row: category, id, rule, title, source, itemType, mode.
    assert.equal(junkRows().length, 1);
    const row = junkRows()[0];
    assert.equal(row[0], 'junk_title');
    assert.equal(row[2].id, 'junk-1');
    assert.equal(row[2].rule, 'placeholder');
    assert.equal(row[2].title, 'Untitled Job');
    assert.equal(row[2].source, 'sathijob');
    assert.equal(row[2].itemType, 'job');
    assert.equal(row[2].mode, 'main');

    // (d) throttle: same id+rule refused again, no second audit row.
    const again = await postEventToCategory(bot, junk, 'main');
    assert.equal(again.reason, 'junk_title');
    assert.equal(junkRows().length, 1, 'one audit row per id+rule per process');

    // (e) no force bypass.
    const forced = await postEventToCategory(bot, junk, 'main', null, true);
    assert.equal(forced.reason, 'junk_title');

    // (f) a different item gets its own row; junk wins over missing image.
    const other = { id: 'junk-2', title: 'MANAGEMENT', source: 'yarsalabs', itemType: 'job', category: 'jobs' };
    const r2 = await postEventToCategory(bot, other, 'main');
    assert.equal(r2.reason, 'junk_title');
    assert.equal(r2.junkRule, 'allcaps_single');
    assert.equal(junkRows().length, 2);
});

test('control: real title is not refused as junk; junk call site is mode=main only', async () => {
    devMode.noteBlocked = () => false;
    const before = junkRows().length;

    // Real title, NO image: stops at the later no-image gate, before any
    // marker reserve or Discord send. Only assert it was not junk-refused.
    const real = { id: 'real-1', title: 'Senior QA Engineer', source: 'merojob', itemType: 'job', category: 'jobs' };
    const r = await postEventToCategory(makeBot(), real, 'main');
    assert.notEqual(r.reason, 'junk_title');
    assert.equal(r.ok, false, 'no image, so it must be refused downstream, never posted');
    assert.equal(junkRows().length, before);

    // Operator allow-list reaches the gate through bot.cache.settings.
    const allowed = { id: 'junk-3', title: 'Untitled Job', source: 'sathijob', itemType: 'job', category: 'jobs' };
    const r3 = await postEventToCategory(makeBot({ junkTitle: { allow: ['Untitled Job'] } }), allowed, 'main');
    assert.notEqual(r3.reason, 'junk_title');
    assert.equal(r3.ok, false);

    // mode=test must stay ungated. A behavioural check would run the test
    // path into marker reserve + Discord send, so assert the call-site shape.
    const src = fs.readFileSync(require.resolve('../../src/posting/post'), 'latin1');
    assert.match(src, /const junkRule = mode === 'main'\s*\?\s*getJunkTitleReason\(/);
    assert.equal((src.match(/getJunkTitleReason\(/g) || []).length, 1, 'exactly one call site');
});
