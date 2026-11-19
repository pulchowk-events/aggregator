// src/posting/imageBytes.js
// Decide what bytes actually get attached to a Discord post. Content-type and
// URL extension are not trustworthy (favicons are ICO, some sites serve SVG),
// and Discord only previews PNG/JPEG/GIF/WEBP. Anything else is swapped for
// the source's committed placeholder PNG.
const fs = require('fs');
const path = require('path');

function sniffImageExt(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
}

function loadPlaceholderBuffer(source) {
    const base = String(source || '').toLowerCase();
    const candidates = [base, base.replace(/-\d+$/, '')];
    for (const name of candidates) {
        if (!/^[a-z0-9_-]+$/.test(name)) continue;
        const p = path.join(__dirname, '..', '..', 'assets', 'placeholders', name + '.png');
        try {
            if (fs.existsSync(p)) return fs.readFileSync(p);
        } catch (e) { /* try next candidate */ }
    }
    return null;
}

// Returns { buffer, ext, swapped }. Throws when the bytes are not a
// Discord-previewable image and no placeholder exists (caller falls back
// to a text-only post).
function resolveAttachmentImage(buffer, source) {
    const ext = sniffImageExt(buffer);
    if (ext) return { buffer, ext, swapped: false };
    const ph = loadPlaceholderBuffer(source);
    if (ph && sniffImageExt(ph)) return { buffer: ph, ext: 'png', swapped: true };
    throw new Error('image bytes are not PNG/JPEG/GIF/WEBP and no placeholder exists for source "' + source + '"');
}

module.exports = { sniffImageExt, loadPlaceholderBuffer, resolveAttachmentImage };
