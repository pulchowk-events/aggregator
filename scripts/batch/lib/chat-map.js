// scripts/batch/lib/chat-map.js
//
// Persistence layer for chat URLs across retries.
//
// Keyed by `<sourceName>::<provider>` because the same source can have
// one chat on DeepSeek and a different one on Qwen (via the pivot
// pattern on rate limit). Each provider's chat has a stable URL that
// contains a UUID — the UUID is the real identity, the URL is just
// where to navigate.
//
// Written after every successful /chat, so a mid-batch crash doesn't
// lose the URLs for already-completed sources. A fresh run directory
// starts with an empty map.
//
// Reverses nothing — the sidebar walk fallback in deepseek-connect is
// still used when no URL is present, so a missing entry degrades to
// the pre-v0.2.0 behavior rather than failing.

'use strict';

const fs = require('fs');
const path = require('path');

class ChatMap {
    constructor(runDir) {
        this.path = path.join(runDir, 'chat-map.json');
        this.data = {};
        try {
            this.data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        } catch (_) { /* fresh run — empty map */ }
    }

    get(sourceName, provider) {
        const key = `${sourceName}::${provider || 'deepseek'}`;
        return this.data[key] || null;
    }

    set(sourceName, provider, value) {
        const key = `${sourceName}::${provider || 'deepseek'}`;
        this.data[key] = value;
        this.save();
    }

    save() {
        try {
            fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch (e) {
            // best-effort — a failure to persist shouldn't fail the batch
        }
    }
}

module.exports = { ChatMap };
