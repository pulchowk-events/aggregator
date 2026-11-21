// src/scrapers/imageSniff.js
// Identify an image by its magic bytes. Headers and URL extensions lie (HTML soft
// 404s, .ico served as image/*, missing content-type); the bytes do not.
// Only the formats Discord previews reliably are accepted: jpg, png, gif, webp.
// Returns { ext, mime } or null. Never throws.

function sniffImage(input) {
    try {
        if (!input) return null;
        const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
        if (b.length < 12) return null;
        if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
            b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return { ext: 'png', mime: 'image/png' };
        const gif = b.toString('latin1', 0, 6);
        if (gif === 'GIF87a' || gif === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
        if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
        return null;
    } catch (e) {
        return null;
    }
}

module.exports = { sniffImage };
