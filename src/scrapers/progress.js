// src/scrapers/progress.js
// Scrape progress tracker: percent complete + self-correcting ETA.
//
// Every source reports into this via three methods:
//   discovered(n)  — "I found n more items to process"
//   unitDone(n)    — "I finished n more items"
//   sourceDone(src)— "source <src> finished (ok/failed)"
//
// The ETA is an exponential moving average of seconds-per-item, seeded from
// the first completed unit and self-correcting as the run proceeds. That's
// deliberate — a static "items/sec" estimate from the first item is wildly
// wrong for scrapers whose per-item cost varies with payload size.
//
// Reporters should call unitDone() in a `finally` block so a failed item
// still advances the ETA — otherwise a run that starts failing at item 3
// freezes the bar at 3/total forever.

class ScrapeProgressTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.total = 0;
        this.completed = 0;
        this.startedAt = null;
        // EMA_ALPHA controls how fast the ETA reacts to recent speed:
        // higher = trusts the most recent item more, lower = smoother but
        // slower to correct. 0.3 is the same value the original bot used.
        this.perUnitEMA = null;
        this.EMA_ALPHA = 0.3;
        this.lastUnitCompletedAt = null;
        this.sourceStatus = {};
    }

    start(sources) {
        this.reset();
        this.startedAt = Date.now();
        for (const s of sources) this.sourceStatus[s] = 'running';
    }

    discovered(n = 1) {
        this.total += n;
    }

    unitDone(n = 1) {
        const now = Date.now();
        const ref = this.lastUnitCompletedAt || this.startedAt;
        if (ref) {
            const dt = (now - ref) / 1000 / n;
            this.perUnitEMA = this.perUnitEMA == null
                ? dt
                : (this.EMA_ALPHA * dt + (1 - this.EMA_ALPHA) * this.perUnitEMA);
        }
        this.lastUnitCompletedAt = now;
        this.completed += n;
    }

    sourceDone(source, ok = true) {
        this.sourceStatus[source] = ok ? 'done' : 'error';
    }

    percent() {
        if (this.total === 0) return this.completed > 0 ? 100 : 0;
        return Math.min(100, Math.round((this.completed / this.total) * 100));
    }

    etaSeconds() {
        if (this.perUnitEMA == null || this.total === 0) return null;
        return Math.max(0, Math.round((this.total - this.completed) * this.perUnitEMA));
    }

    elapsedSeconds() {
        return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    }

    renderBar(width = 20) {
        const filled = Math.round((this.percent() / 100) * width);
        return '█'.repeat(filled) + '░'.repeat(width - filled);
    }

    toJSON() {
        return {
            total: this.total,
            completed: this.completed,
            percent: this.percent(),
            etaSeconds: this.etaSeconds(),
            elapsedSeconds: this.elapsedSeconds(),
            sourceStatus: this.sourceStatus
        };
    }
}

// Convenience wrappers so scraper plugins can call `report.discovered(n)`
// without null-checking a possibly-absent tracker every time. Every wrapper
// is a no-op if the tracker is absent — a source run manually (outside the
// bot) still works.
function safeDiscovered(progress, n = 1) {
    if (progress && typeof progress.discovered === 'function') progress.discovered(n);
}
function safeUnitDone(progress, n = 1) {
    if (progress && typeof progress.unitDone === 'function') progress.unitDone(n);
}
function safeSourceDone(progress, source, ok = true) {
    if (progress && typeof progress.sourceDone === 'function') progress.sourceDone(source, ok);
}

module.exports = {
    ScrapeProgressTracker,
    safeDiscovered,
    safeUnitDone,
    safeSourceDone
};
