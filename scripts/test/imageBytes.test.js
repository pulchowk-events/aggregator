// test/imageBytes.test.js -- regression cover for byte-sniffed attachment + placeholder swap.
// Run: node scripts/test/imageBytes.test.js
const assert = require('assert');
const fs = require('fs');
const { sniffImageExt, resolveAttachmentImage } = require('../../src/posting/imageBytes');

function makeIco() {
    const b = Buffer.alloc(64, 0);
    b[2] = 0x01; // type=1 (icon), header 00 00 01 00
    b[4] = 0x01;
    return b;
}
function makePng() {
    const b = Buffer.alloc(32, 0);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    return b;
}

let failed = 0;
function t(name, fn) {
    try { fn(); console.log('ok   - ' + name); }
    catch (e) { failed++; console.log('FAIL - ' + name + ': ' + e.message); }
}

t('ICO bytes are not sniffed as previewable', () => {
    assert.strictEqual(sniffImageExt(makeIco()), null);
});

t("(1) ICO + source 'blacktech' -> swapped=true with PNG bytes", () => {
    const r = resolveAttachmentImage(makeIco(), 'blacktech');
    assert.strictEqual(r.swapped, true);
    assert.strictEqual(r.ext, 'png');
    assert.strictEqual(sniffImageExt(r.buffer), 'png');
});

t("(2) ICO + source 'blacktech-2' -> swapped=true with PNG bytes", () => {
    const r = resolveAttachmentImage(makeIco(), 'blacktech-2');
    assert.strictEqual(r.swapped, true);
    assert.strictEqual(r.ext, 'png');
    assert.strictEqual(sniffImageExt(r.buffer), 'png');
});

t('(3) PNG bytes + any source -> swapped=false, original bytes', () => {
    const png = makePng();
    for (const src of ['blacktech', 'blacktech-2', 'unknownsource', '']) {
        const r = resolveAttachmentImage(png, src);
        assert.strictEqual(r.swapped, false);
        assert.strictEqual(r.ext, 'png');
        assert.strictEqual(r.buffer, png);
    }
});

t('ICO + unknown source throws (caller falls back to text-only)', () => {
    assert.throws(() => resolveAttachmentImage(makeIco(), 'unknownsource'));
});

if (fs.existsSync('/tmp/bt-fav.bin')) {
    t('real blacktech favicon bytes swap to PNG', () => {
        const r = resolveAttachmentImage(fs.readFileSync('/tmp/bt-fav.bin'), 'blacktech-2');
        assert.strictEqual(r.swapped, true);
        assert.strictEqual(sniffImageExt(r.buffer), 'png');
    });
}

if (failed) { console.log(failed + ' test(s) failed'); process.exitCode = 1; }
else console.log('all tests passed');
