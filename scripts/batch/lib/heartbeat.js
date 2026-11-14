// scripts/batch/lib/heartbeat.js
// Shared heartbeat utility for batch phases. Tracks named in-flight
// operations, prints status for ops that exceed a minimum age every N
// seconds. Without it, the terminal looks stuck when one operation
// (browser launch, slow site, fetch wait) takes a while -- the user
// can't tell "working" from "hung".
//
// Design:
//   - Caller drives lifecycle: setOp(name, status) on start or status
//     change; endOp(name) when done.
//   - Helper owns the timer. On each tick it computes the active set
//     (operations with age >= minAgeMs) and calls onTick with that list.
//   - onTick renders. Caller keeps its own UI style (colors, ts prefix).
//   - Silent when nothing is over minAgeMs. Fast operations don't spam.
//
// Used by verify.js (was inline, migrated), generate.js (new -- the
// wizard pool has 5-30s silent windows), discover.js (per-URL timing),
// paste.js (clipboard wait).

class Heartbeat {
    constructor({ intervalMs = 3000, minAgeMs = 3000 } = {}) {
        this.intervalMs = intervalMs;
        this.minAgeMs = minAgeMs;
        this.ops = new Map();
        this.timer = null;
        this.onTickFn = null;
    }

    onTick(fn) {
        this.onTickFn = fn;
        return this;
    }

    // Start (or update) an operation. If the op already exists, only the
    // status changes -- the age clock keeps running.
    setOp(name, status) {
        const existing = this.ops.get(name);
        if (existing) {
            existing.status = status;
        } else {
            this.ops.set(name, { startedAt: Date.now(), status });
        }
    }

    endOp(name) {
        this.ops.delete(name);
    }

    // Operations over minAgeMs, as [{name, status, ageMs}]. Useful for
    // one-shot status prints outside the heartbeat timer.
    active() {
        const now = Date.now();
        const out = [];
        for (const [name, op] of this.ops) {
            const ageMs = now - op.startedAt;
            if (ageMs >= this.minAgeMs) {
                out.push({ name, status: op.status, ageMs });
            }
        }
        return out;
    }

    start() {
        if (this.timer) return this;
        this.timer = setInterval(() => {
            const activeOps = this.active();
            if (activeOps.length > 0 && this.onTickFn) {
                this.onTickFn(activeOps);
            }
        }, this.intervalMs);
        // Do not keep the process alive for the heartbeat alone. If the
        // phase's primary promise is settled and this is the last timer,
        // the process should exit cleanly.
        if (this.timer.unref) this.timer.unref();
        return this;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.ops.clear();
        return this;
    }
}

module.exports = { Heartbeat };
