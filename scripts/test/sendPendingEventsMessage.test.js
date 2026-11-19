'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sendOnePendingEmbed } = require('../../src/discord/sendPendingEventsMessage');

const NEPVENTS_SRC = fs.readFileSync(
    path.join(__dirname, '../../src/scrapers/extractors/events/nepvents.js'), 'utf8'
);

function fakeBot() {
    return {
        hasDataQualityWarnings: () => false,
        isEventTooSoon: () => false,
        getAutopostMinLeadDays: () => 3,
        hasValidImage: () => true,
        isStuckNeedsAttentionEvent: () => false,
        getNeedsAttentionExpiryDays: () => 7
    };
}
function fakeChannel() {
    const sent = [];
    return { sent, send: async (payload) => { sent.push(payload); } };
}
function jobEvent(overrides = {}) {
    return {
        id: 'test-1', source: 'unit', itemType: 'job', title: 'Engineer',
        description: 'Short.', date: '2099-01-01', location: 'Kathmandu',
        price: 'Rs. 1', image: 'https://example.com/a.png', ...overrides
    };
}

test('2000-char field values are clamped, do not throw, other fields intact', async () => {
    const channel = fakeChannel();
    const long = 'x'.repeat(2000);
    await assert.doesNotReject(
        sendOnePendingEmbed(fakeBot(), channel, jobEvent({ location: long, price: long }))
    );
    assert.equal(channel.sent.length, 1);
    const fields = channel.sent[0].embeds[0].data.fields;
    assert.equal(fields.length, 3);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(byName['Apply By'], '2099-01-01');
    for (const key of ['Location', 'Salary']) {
        assert.ok(byName[key].length <= 1024, `${key} too long`);
        assert.ok(byName[key].endsWith('\u2026'), `${key} missing ellipsis`);
    }
});

test('oversized title/description are clamped, appended notes survive, short event unchanged', async () => {
    const channel = fakeChannel();
    await assert.doesNotReject(sendOnePendingEmbed(
        fakeBot(), channel,
        jobEvent({ title: 't'.repeat(400), description: 'd'.repeat(10000), testPosted: true })
    ));
    const big = channel.sent[0].embeds[0].data;
    assert.ok(big.title.length <= 256);
    assert.ok(big.description.length <= 4096);
    assert.ok(big.description.includes('Test-posted'));

    const control = fakeChannel();
    await sendOnePendingEmbed(fakeBot(), control, jobEvent());
    const small = control.sent[0].embeds[0].data;
    assert.equal(small.title, 'Engineer');
    assert.ok(small.description.startsWith('Short.'));
    assert.equal(small.fields.find((f) => f.name === 'Location').value, 'Kathmandu');
});

test('nepvents getText collapses whitespace and leaves single-spaced text alone', () => {
    const m = NEPVENTS_SRC.match(/const getText = (\(el\) => .*);/);
    assert.ok(m, 'getText definition not found');
    const getText = new Function(`return ${m[1]};`)();
    assert.equal(getText({ textContent: '  a  b   c ' }), 'a b c');
    assert.equal(getText({ textContent: 'a b c' }), 'a b c');
    assert.equal(getText(null), null);
});

test('nepvents source has no over-escaped CSS selector (static regression)', () => {
    assert.ok(!NEPVENTS_SRC.includes(String.raw`md\\\\:`), 'over-escaped selector present');
    assert.ok(NEPVENTS_SRC.includes(
        String.raw`getText(document.querySelector('h1.text-2xl.md\\:text-3xl.font-bold'))`
    ));
});
