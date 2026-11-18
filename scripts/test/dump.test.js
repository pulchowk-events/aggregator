// scripts/test/dump.test.js
// Bugs 4+5 in scripts/wizard/dump.js.
//
// RED STRUCTURE -- before the dump.js patch this file fails 5/5, for TWO different reasons:
//   tests 1+2 (Puppeteer)   -> AssertionError. They run against the CURRENT code and prove the bugs:
//       1: querySelector returns the hero wrapper (first class-subset match), not a job card
//       2: the 3000-byte floor swaps a correct small card for the whole page
//     Both go through dumpListingPage because dumpCardHtml is not exported yet. A direct call
//     would die with a missing-export TypeError and blur the two reasons.
//   tests 3+4+5 (pure Node) -> TypeError "dump.hrefMatches / dump.appearsInCards is not a function".
//     They prove the helpers are new (missing exports); they say nothing about logic yet.
// After the patch all 5 pass.
//
// If the wizard browser cannot launch, tests 1+2 SKIP instead of failing. A skip is NOT a RED.
// Guards prefixed "FIXTURE:" mean the fixture is wrong, not dump.js.

const test = require('node:test');
const assert = require('node:assert');

const dump = require('../wizard/dump');

let session = null;
let skipReason = null;

test.before(async () => {
    try {
        const { createSession } = require('../wizard/browser');
        session = await createSession();
    } catch (err) {
        session = null;
        skipReason = 'wizard browser unavailable: ' + String((err && err.message) || err).split('\n')[0];
    }
}, { timeout: 60000 });

test.after(async () => {
    if (session) await session.close();
});

// Runs fn(page) on a page whose document is `html`. The about:blank origin is fine here:
// URL-resolution failures inside dumpListingPage's evaluate block are caught there.
async function onFixture(t, html, fn) {
    if (!session) {
        t.skip(skipReason);
        return undefined;
    }
    return session.withPage(async (page) => {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        return fn(page);
    });
}

// ---- fixtures ---------------------------------------------------------------

const BLURB = 'Join the platform team and build and ship production services that are used across the whole company every single day.';

// Test 1: a hero wrapper carrying the SAME class as the real cards sits first in the DOM. It is
// over 3000 bytes on purpose, so the 3000-byte floor cannot rescue the wrong pick and this
// isolates the querySelector half of bug 4.
const HERO_OPTIONS = Array.from({ length: 160 }, (_, i) => '<option value="c' + i + '">Category ' + i + '</option>').join('');
const FORM_FIRST_HTML = [
    '<!doctype html><html><head><title>Careers</title></head><body><main>',
    '<section class="hero"><div class="col-lg-6 hero-search" data-marker="hero-wrapper">',
    '<form id="hero-search-form" action="/search"><label>Find your next job</label>',
    '<input name="q"><select name="cat">' + HERO_OPTIONS + '</select></form></div></section>',
    '<section id="open-roles"><div class="row">',
    '<div class="col-lg-6" data-marker="real-card-1"><h3>Software Engineer</h3><p>' + BLURB + '</p><a href="/jobs/software-engineer">Apply now</a></div>',
    '<div class="col-lg-6" data-marker="real-card-2"><h3>QA Engineer</h3><p>' + BLURB + '</p><a href="/jobs/qa-engineer">Apply now</a></div>',
    '<div class="col-lg-6" data-marker="real-card-3"><h3>Data Analyst</h3><p>' + BLURB + '</p><a href="/jobs/data-analyst">Apply now</a></div>',
    '</div></section></main></body></html>'
].join('\n');

// Test 2: one clean card group (li.job-item x4), each card well under 3000 bytes, inside a page
// whose <main> is larger. Today the floor swaps the correct <li> for the fallback block.
const ROLE_ITEMS = [
    ['Backend Developer', 'backend-developer'],
    ['Frontend Developer', 'frontend-developer'],
    ['DevOps Engineer', 'devops-engineer'],
    ['Product Designer', 'product-designer']
].map(([title, slug], i) =>
    '<li class="job-item" data-marker="job-' + (i + 1) + '"><h3>' + title + '</h3><p>' + BLURB + '</p><a href="/jobs/' + slug + '">View role</a></li>'
).join('\n');
const SMALL_CARD_HTML = [
    '<!doctype html><html><head><title>Careers</title></head><body><main>',
    '<section class="intro"><p>' + 'We are a product engineering company hiring across several teams. '.repeat(30) + '</p></section>',
    '<ul class="results">' + ROLE_ITEMS + '</ul>',
    '</main></body></html>'
].join('\n');

// ---- 1. bug 4: wrong element (Puppeteer) -------------------------------------

test('dumpCardHtml skips leading form-wrapper match, returns real card', { timeout: 60000 }, async (t) => {
    await onFixture(t, FORM_FIRST_HTML, async (page) => {
        const probe = await page.evaluate(() => {
            const first = document.querySelector('div.col-lg-6');
            return { marker: first && first.getAttribute('data-marker'), size: first ? first.outerHTML.length : 0 };
        });
        assert.strictEqual(probe.marker, 'hero-wrapper', 'FIXTURE: first div.col-lg-6 must be the hero wrapper');
        assert.ok(probe.size >= 3000, 'FIXTURE: hero wrapper must exceed the 3000-byte floor, got ' + probe.size);

        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.selector === 'div.col-lg-6' && top.count === 3,
            'FIXTURE: expected cardCandidates[0] = div.col-lg-6 x3, got ' + JSON.stringify(top && { selector: top.selector, count: top.count }));

        const raw = out.rawCardHtml;
        assert.ok(raw && raw.html, 'rawCardHtml missing');
        assert.ok(!raw.html.includes('hero-search-form'),
            'BUG 4: representative card is the hero search wrapper (querySelector took the first class-subset match)');
        assert.match(raw.html, /data-marker="real-card-\d"/, 'BUG 4: representative card is not one of the real job cards');
        assert.strictEqual(raw.label, 'rawCardHtml', 'unexpected label ' + raw.label);
    });
});

// ---- 2. bug 4: 3000-byte floor swaps in <main> (Puppeteer, through line 613) ---

test('dumpListingPage keeps sub-3000-byte card instead of swapping in main', { timeout: 60000 }, async (t) => {
    await onFixture(t, SMALL_CARD_HTML, async (page) => {
        const size = await page.evaluate(() => document.querySelector('li.job-item').outerHTML.length);
        assert.ok(size > 0 && size < 3000, 'FIXTURE: first card must be under 3000 bytes, got ' + size);

        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.selector === 'li.job-item' && top.count === 4,
            'FIXTURE: expected cardCandidates[0] = li.job-item x4, got ' + JSON.stringify(top && { selector: top.selector, count: top.count }));

        const raw = out.rawCardHtml;
        assert.ok(raw && raw.html, 'rawCardHtml missing');
        assert.strictEqual(raw.label, 'rawCardHtml',
            'BUG 4 (floor): small card was replaced by the fallback, label=' + raw.label + ' finalSize=' + raw.finalSize);
        assert.ok(raw.html.trim().startsWith('<li'),
            'BUG 4 (floor): representative card is not the <li>, head=' + JSON.stringify(raw.html.slice(0, 60)));
        assert.match(raw.html, /data-marker="job-\d"/, 'BUG 4 (floor): representative card is not one of the job items');
    });
});

// ---- 3-5. bug 5: pure Node, helpers are new ---------------------------------

test('hrefMatches rejects /jobs/page/2 against card hrefs', () => {
    const pagination = 'https://careers.example.test/jobs/page/2';
    // Each of these contains a "2" somewhere, which is what fooled the old substring test.
    const cardHrefs = ['/jobs/senior-engineer-2', '/jobs/page/1', '/jobs/page/20', '/jobs/designer'];
    for (const h of cardHrefs) {
        assert.strictEqual(dump.hrefMatches(h, pagination), false, h + ' must not match ' + pagination);
    }
    // Guard against a helper that is simply always false.
    assert.strictEqual(dump.hrefMatches('/jobs/page/2', pagination), true);
});

test('hrefMatches accepts full /job/R0151442 path', () => {
    const candidate = 'https://careers.example.test/job/R0151442';
    assert.strictEqual(dump.hrefMatches('/job/R0151442', candidate), true, 'site-relative');
    assert.strictEqual(dump.hrefMatches('/job/R0151442/', candidate), true, 'trailing slash');
    assert.strictEqual(dump.hrefMatches('https://careers.example.test/job/R0151442', candidate), true, 'absolute');
    assert.strictEqual(dump.hrefMatches('/job/R0151443', candidate), false, 'neighbouring id');
    assert.strictEqual(dump.hrefMatches('/job/R015144', candidate), false, 'prefix of the id');
});

test('appearsInCards falls back to sampleHtml only when hrefs is undefined', () => {
    const candidates = ['https://careers.example.test/job/R0151442'];
    const sampleHtml = '<li class="job-item"><a href="/job/R0151442">Backend Developer</a></li>';
    assert.strictEqual(dump.appearsInCards([{ sampleHtml }], candidates), true, 'no hrefs -> old sampleHtml test');
    assert.strictEqual(dump.appearsInCards([{ sampleHtml, hrefs: [] }], candidates), false, 'hrefs: [] is authoritative');
    assert.strictEqual(dump.appearsInCards([{ sampleHtml, hrefs: ['/job/other'] }], candidates), false, 'hrefs beat sampleHtml');
    assert.strictEqual(dump.appearsInCards([{ sampleHtml, hrefs: ['/job/R0151442'] }], candidates), true, 'hrefs match');
    assert.strictEqual(dump.appearsInCards([{ hrefs: ['/x'] }, { hrefs: ['/job/R0151442'] }], candidates), true, 'any card may match');
});
