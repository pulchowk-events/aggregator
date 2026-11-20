const test = require('node:test');
const assert = require('node:assert');

const { fitHtmlToBudget } = require('../wizard/dump');

function assertBalancedHtml(html) {
    const stack = [];
    const voidTags = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'
    ]);
    for (const match of html.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
        const tag = match[1].toLowerCase();
        const token = match[0];
        if (token.startsWith('</')) {
            assert.strictEqual(stack.pop(), tag, 'unexpected closing tag ' + token);
        } else if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) {
            stack.push(tag);
        }
    }
    assert.deepStrictEqual(stack, []);
}

test('HTML budget truncation keeps a balanced DOM and stays within UTF-8 bytes', () => {
    const source = '<article><div class="title"><h2>Engineer opening</h2></div>' +
        '<section class="description"><p>' + 'café&nbsp;'.repeat(1000) +
        '</p><a href="/apply">Apply</a></section></article>';
    const result = fitHtmlToBudget(source, 512, 'fixture');

    assert.ok(result.truncated);
    assert.ok(result.html.includes('<h2>Engineer opening</h2>'));
    assert.ok(result.html.includes('remaining DOM omitted'));
    assert.ok(Buffer.byteLength(result.html, 'utf8') <= 512);
    assert.strictEqual(result.finalSize, Buffer.byteLength(result.html, 'utf8'));
    assertBalancedHtml(result.html);
});

test('HTML already under budget is retained unchanged', () => {
    const html = '<article><h2>Engineer</h2><a href="/jobs/1">Apply</a></article>';
    const result = fitHtmlToBudget(html, 1024, 'fixture');

    assert.strictEqual(result.html, html);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.finalSize, Buffer.byteLength(html, 'utf8'));
});
