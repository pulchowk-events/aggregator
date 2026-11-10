// src/scrapers/retry.js
// Generic retry-with-backoff used by every source when navigating or
// extracting. Exponential backoff (base * 2^attempt) so a transient 500
// or network hiccup doesn't waste a whole source run.
//
// Contract: on the LAST failed attempt, the error from that attempt is
// re-thrown — the caller sees exactly what went wrong, not a wrapper.

async function withRetry(fn, { retries = 2, label = 'operation', baseDelayMs = 2000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                const backoff = baseDelayMs * Math.pow(2, attempt);
                console.warn(`⚠️ ${label} failed (attempt ${attempt + 1}/${retries + 1}): ${error.message}. Retrying in ${backoff}ms...`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
    }
    throw lastError;
}

module.exports = { withRetry };
