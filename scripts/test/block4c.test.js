const test = require('node:test');
const assert = require('node:assert');
const scrape = require('../../src/discord/commands/scrape.js');
const { sniffImageExt, resolveAttachmentImage } = require('../../src/posting/imageBytes.js');

const SOURCES = [
    { name: 'blacktech', type: 'jobs' },
    { name: 'khalti', type: 'events' },
    { name: 'merojob', type: 'jobs' }
];

test('1. autocomplete "black" returns blacktech', () => {
    const c = scrape.siteChoices('black', SOURCES);
    assert.deepStrictEqual(c.map((x) => x.value), ['blacktech']);
});

test('2. autocomplete "xyz" returns empty array', () => {
    assert.deepStrictEqual(scrape.siteChoices('xyz', SOURCES), []);
});

test('3. autocomplete caps at 25 even with 41 matches', () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ name: 'src' + i, type: 'jobs' }));
    const c = scrape.siteChoices('src', many);
    assert.strictEqual(c.length, 25);
    assert.ok(c.every((x) => x.name.length <= 100 && x.value.length <= 100));
});

test('4. ICO bytes -> real PNG placeholder bytes, not ICO named jpg', () => {
    const header = Buffer.from(['0000', '0100', '0300', '1010', '0000', '0100', '2000', '6804',
        '0000', '3600', '0000', '2020', '0000', '0100', '2000', '2811'].join(''), 'hex');
    const ico = Buffer.concat([header, Buffer.alloc(200)]);
    assert.strictEqual(sniffImageExt(ico), null);
    const r = resolveAttachmentImage(ico, 'blacktech');
    assert.strictEqual(r.swapped, true);
    assert.strictEqual(r.ext, 'png');
    assert.strictEqual(sniffImageExt(r.buffer), 'png');
    assert.notStrictEqual(r.buffer, ico);
});

test('5. valid PNG passes through unchanged', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
    const r = resolveAttachmentImage(png, 'blacktech');
    assert.strictEqual(r.swapped, false);
    assert.strictEqual(r.ext, 'png');
    assert.strictEqual(r.buffer, png);
});

test('6. raw SVG text bytes are swapped to placeholder; unknown source throws', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const r = resolveAttachmentImage(svg, 'blacktech');
    assert.strictEqual(r.swapped, true);
    assert.strictEqual(sniffImageExt(r.buffer), 'png');
    assert.throws(() => resolveAttachmentImage(svg, 'no-such-source-xyz'));
});

test('7. real autocomplete handler responds via registry with blacktech', async () => {
    const sent = [];
    const fake = {
        options: { getFocused: () => ({ name: 'site', value: 'black' }) },
        respond: async (c) => { sent.push(c); }
    };
    await scrape.autocomplete({}, fake);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].some((x) => x.value === 'blacktech'));
});
