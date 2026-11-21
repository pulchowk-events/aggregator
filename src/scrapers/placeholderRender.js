// src/scrapers/placeholderRender.js
// Render a 1024x1024 placeholder PNG in-process (no Chromium, no committed file, no URL).
// Visual matches scripts/generate-placeholders.js: black background, white bold name
// centered, dim "PULCHOWK EVENTS" mark near the bottom, name auto-fit to 864px.
//
// Synchronous, deterministic (one bundled font, system fonts off), never needs the
// network. The bot runs on a local machine Discord cannot reach, so post.js uploads the
// returned Buffer as a file attachment instead of handing Discord a URL.
//
// @resvg/resvg-js is required lazily so a missing install fails at render time (caught in
// post.js, falls back to text-only) rather than crashing the bot at startup.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FONT_PATH = path.join(REPO, 'assets', 'fonts', 'Inter-Bold.ttf');
const CANVAS = 1024;
const MAX_TEXT_W = 864;
const BRAND = 'PULCHOWK EVENTS';
const CACHE_MAX = 200;

let ResvgCtor = null;
function loadResvg() {
    if (!ResvgCtor) ResvgCtor = require('@resvg/resvg-js').Resvg;
    return ResvgCtor;
}

const pngCache = new Map();

// Slugs ('margintopsolutions', 'tech-101') are humanized; real names pass through.
function displayName(label) {
    const raw = String(label === null || label === undefined ? '' : label).trim();
    if (!raw) return 'Pulchowk Events';
    if (/^[a-z0-9_-]+$/i.test(raw)) {
        const cleaned = raw.replace(/-/g, ' ').trim();
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    return raw;
}

function fontSizeFor(text) {
    const raw = MAX_TEXT_W / Math.max(1, text.length * 0.72);
    return Math.min(140, Math.max(28, Math.round(raw)));
}

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function resvgOptions() {
    if (fs.existsSync(FONT_PATH)) {
        return { font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: 'Inter' } };
    }
    return { font: { loadSystemFonts: true } };
}

function nameTextEl(text, size) {
    const y = (CANVAS / 2) + size * 0.35;
    return '<text x="' + (CANVAS / 2) + '" y="' + y.toFixed(1) + '" text-anchor="middle"'
        + ' font-family="Inter, Arial, sans-serif" font-weight="700" font-size="' + size + '"'
        + ' letter-spacing="' + (-0.02 * size).toFixed(2) + '" fill="#ffffff">' + xmlEscape(text) + '</text>';
}

function svgWrap(inner, background) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + CANVAS + '" height="' + CANVAS
        + '" viewBox="0 0 ' + CANVAS + ' ' + CANVAS + '">'
        + (background ? '<rect width="' + CANVAS + '" height="' + CANVAS + '" fill="#000000"/>' : '')
        + inner + '</svg>';
}

// Measure the name alone (no background rect, which would make the bbox 1024 wide).
function measureWidth(text, size, opts) {
    try {
        const Resvg = loadResvg();
        const bbox = new Resvg(svgWrap(nameTextEl(text, size), false), opts).getBBox();
        if (bbox && Number.isFinite(bbox.width)) return bbox.width;
    } catch (e) { /* fall through to estimate */ }
    return text.length * size * 0.62;
}

/**
 * @param {string} label  Company / organizer / source slug to print.
 * @returns {Buffer} PNG bytes. Throws if @resvg/resvg-js is unavailable.
 */
function renderPlaceholderPng(label) {
    const text = displayName(label);
    if (pngCache.has(text)) return pngCache.get(text);

    const Resvg = loadResvg();
    const opts = resvgOptions();

    let size = fontSizeFor(text);
    while (size > 20 && measureWidth(text, size, opts) > MAX_TEXT_W) size -= 2;

    const brand = '<text x="' + (CANVAS / 2) + '" y="968" text-anchor="middle"'
        + ' font-family="Inter, Arial, sans-serif" font-weight="700" font-size="18" letter-spacing="3.6"'
        + ' fill="#ffffff" fill-opacity="0.45">' + xmlEscape(BRAND) + '</text>';
    const svg = svgWrap(nameTextEl(text, size) + brand, true);

    const png = Buffer.from(new Resvg(svg, opts).render().asPng());
    if (pngCache.size >= CACHE_MAX) pngCache.clear();
    pngCache.set(text, png);
    return png;
}

// URLs our own fallback layer produces (GitHub raw under assets/placeholders, or the local
// /placeholders route). Anything matching is replaced by a locally rendered PNG.
function isGeneratedPlaceholder(url) {
    return typeof url === 'string' && /\/(?:assets\/)?placeholders\/[a-z0-9_-]+\.png(?:\?|$)/i.test(url);
}

// True when post.js should render + attach a placeholder instead of fetching event.image:
// a generated-placeholder URL, or no image at all. Scholarships with no image stay text-only
// (images are optional for them), but a placeholder URL on one is still rendered.
function canUsePlaceholder(event) {
    if (!event) return false;
    if (isGeneratedPlaceholder(event.image)) return true;
    return !event.image && event.itemType !== 'scholarship';
}

function placeholderLabelFor(event) {
    return (event && (event.company || event.organizer || event.source)) || 'Pulchowk Events';
}

module.exports = {
    renderPlaceholderPng,
    canUsePlaceholder,
    isGeneratedPlaceholder,
    placeholderLabelFor,
    FONT_PATH
};
