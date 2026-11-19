'use strict';
// Block 2b': bare-tag top candidate + truncated class selectors in scripts/wizard/dump.js.
// Browser tests SKIP (not fail) when the wizard browser cannot launch. Hrefs are absolute
// because setContent pages live on about:blank, where relative hrefs cannot resolve.

const test = require('node:test');
const assert = require('node:assert');

const dump = require('../wizard/dump');
const { buildPrompt } = require('../wizard/prompt');

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

const BLURB = 'Join the platform team and build and ship production services that are used across the whole company every single day.';
const BASE = 'https://careers.example.test';

// Real cards are bare <div>s wrapping a job link (blacktech shape). The decoy group is
// bare <div>s too, has MORE siblings, and comes later in the DOM.
const REAL = [['Backend', 'a'], ['Frontend', 'b'], ['Design', 'c'], ['Support', 'd']].map(([t, s], i) =>
    '<div data-marker="real-card-' + (i + 1) + '"><a href="' + BASE + '/career/' + s + '">' + t + ' role. Apply now. ' + BLURB + '</a></div>'
).join('\n');
const DECOY = Array.from({ length: 6 }, (_, i) =>
    '<div data-marker="decoy-' + (i + 1) + '"><h3>Our value ' + i + '</h3><p>' + BLURB + '</p></div>'
).join('\n');
const GENERIC_HTML = [
    '<!doctype html><html><head><title>Careers</title></head><body><main>',
    '<div class="real-list">' + REAL + '</div>',
    '<div class="decoy-list">' + DECOY + '</div>',
    '</main></body></html>'
].join('\n');

const LONG_CLASS = 'flex flex-col p-6 space-y-4 border border-white/40 bg-black hover:bg-white/5 rounded-md transition-all duration-300 job-card-final';
const TITLES = ['Backend Developer', 'Frontend Developer', 'DevOps Engineer', 'Product Designer'];
function cardsHtml(cls) {
    return [
        '<!doctype html><html><head><title>Careers</title></head><body><main><section>',
        TITLES.map((t, i) => '<div class="' + cls + '" data-marker="job-' + (i + 1) + '"><h3>' + t + '</h3><p>' + BLURB + '</p><a href="' + BASE + '/jobs/' + i + '">Apply</a></div>').join('\n'),
        '</section></main></body></html>'
    ].join('\n');
}

// 1. bare-div group: the raw card must be a real card, not the bigger decoy group.
test('bare-div top candidate anchors the raw card to its own hrefs', { timeout: 60000 }, async (t) => {
    await onFixture(t, GENERIC_HTML, async (page) => {
        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.selector === 'div' && top.count === 4,
            'FIXTURE: expected top = bare div x4, got ' + JSON.stringify(top && { selector: top.selector, count: top.count }));
        assert.ok(Array.isArray(top.hrefs) && top.hrefs.length === 4, 'FIXTURE: hrefs ' + JSON.stringify(top && top.hrefs));
        const raw = out.rawCardHtml;
        assert.ok(raw && raw.html, 'rawCardHtml missing');
        assert.ok(!raw.html.includes('decoy-'), 'RESIDUAL 1: picked the decoy layout group');
        assert.match(raw.html, /data-marker="real-card-\d"/, 'RESIDUAL 1: not a real card');
        assert.strictEqual(raw.label, 'rawCardHtml', 'unexpected label ' + raw.label);
    });
});

// 2. weak flag: bare top without job-title evidence -> true; classed top with titles -> false.
test('cardCandidatesWeak flags bare-tag tops only', { timeout: 60000 }, async (t) => {
    await onFixture(t, GENERIC_HTML, async (page) => {
        const out = await dump.dumpListingPage(page);
        assert.strictEqual(out.cardCandidatesWeak, true, 'bare div, ratio 0 -> weak');
    });
    await onFixture(t, cardsHtml('job-card'), async (page) => {
        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.selector === 'div.job-card', 'FIXTURE: top ' + JSON.stringify(top && top.selector));
        assert.strictEqual(out.cardCandidatesWeak, false, 'classed top with job titles -> not weak');
    });
});

// 3. class string > 80 chars: the built selector must still match the real cards.
test('class string over 80 chars yields a selector that matches the cards', { timeout: 60000 }, async (t) => {
    assert.ok(LONG_CLASS.length > 80, 'FIXTURE: class must exceed 80 chars');
    await onFixture(t, cardsHtml(LONG_CLASS), async (page) => {
        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.count === 4, 'FIXTURE: expected top x4, got ' + JSON.stringify(top && { selector: top.selector, count: top.count }));
        assert.ok(top.selector.includes('job-card-final'), 'RESIDUAL 2: selector lost the tail token: ' + top.selector);
        const matched = await page.evaluate((s) => document.querySelectorAll(s).length, top.selector);
        assert.strictEqual(matched, 4, 'RESIDUAL 2: selector matches ' + matched + ' elements, expected 4');
        assert.ok(top.childClass.length <= 80, 'childClass must stay capped at 80 (compat)');
    });
});

// 4. control: short class chain is unchanged.
test('short class chain still produces the same working selector', { timeout: 60000 }, async (t) => {
    await onFixture(t, cardsHtml('job-card'), async (page) => {
        const out = await dump.dumpListingPage(page);
        const top = out.cardCandidates && out.cardCandidates[0];
        assert.ok(top && top.selector === 'div.job-card' && top.count === 4, 'got ' + JSON.stringify(top && { selector: top.selector, count: top.count }));
        const matched = await page.evaluate((s) => document.querySelectorAll(s).length, top.selector);
        assert.strictEqual(matched, 4);
    });
});

// 5. compat (pure Node): a legacy listing without the new field still renders in prompt.js.
test('legacy dump (no cardCandidatesWeak) still renders; new field is tolerated', () => {
    const detected = { type: 'unknown', evidence: {}, signals: {} };
    const legacy = { cardCandidates: [{ selector: 'div.x', count: 3, jobTitleRatio: 0.5 }] };
    const a = buildPrompt({ name: 't', type: 'jobs', url: 'https://x.test', listing: legacy, detail: null, detected });
    assert.ok(a.includes('Card wrapper:') && a.includes('div.x'));
    const b = buildPrompt({ name: 't', type: 'jobs', url: 'https://x.test', listing: Object.assign({}, legacy, { cardCandidatesWeak: true }), detail: null, detected });
    assert.ok(b.includes('Card wrapper:') && b.includes('div.x'));
});
