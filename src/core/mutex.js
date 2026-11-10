// src/core/mutex.js
// Promise-based mutex used to serialize autopost ticks, cache mutations,
// and any other critical section that must not interleave. Guarantees
// FIFO ordering of waiters so a promise rejection in one critical section
// can't starve later callers.

class Mutex {
    constructor() {
        this._locked = false;
        this._waiters = [];
    }

    lock() {
        return new Promise((resolve) => {
            if (!this._locked) {
                this._locked = true;
                resolve();
            } else {
                this._waiters.push(resolve);
            }
        });
    }

    unlock() {
        if (this._waiters.length > 0) {
            const next = this._waiters.shift();
            next();
        } else {
            this._locked = false;
        }
    }

    async runExclusive(fn) {
        await this.lock();
        try {
            return await fn();
        } finally {
            this.unlock();
        }
    }
}

module.exports = { Mutex };
