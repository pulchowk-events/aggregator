// scripts/batch/lib/provider-router.js
//
// The only place the aggregator decides which LLM provider handles a source.
//
// decide(sourceName, cls) resolves, in order:
//   1. classes.json override  (cls.provider)
//   2. --provider CLI flag    (opts.cliProvider; null means "not passed")
//   3. defaultProvider        (constructor option, default 'deepseek')
//
// It REFUSES instead of guessing:
//   unknown_provider      value is not in KNOWN_PROVIDERS
//   conflicting_provider  classes override and --provider are both set and differ
//
// checkTabs(provider, tabs) is the preflight against the extension's live tab
// inventory (client.tabs().tabs). It requires exactly one tab for the provider,
// matched on exact hostname, and throws ambiguous_provider_tab on zero or 2+.
// The extension raises the same code for the same condition.
//
// KNOWN_PROVIDERS / PROVIDER_HOSTS mirror deepseek-connect shared.js
// DSC.PROVIDER_DOMAINS, restricted to providers that have a registered
// extension module (tongyi has a domain but no module, so it is not routable).
// Keep both in sync when adding a provider.

'use strict';

const KNOWN_PROVIDERS = Object.freeze(['deepseek', 'qwen']);
const DEFAULT_PROVIDER = 'deepseek';
const PROVIDER_HOSTS = Object.freeze({
    deepseek: 'chat.deepseek.com',
    qwen: 'chat.qwen.ai',
});

class ProviderRouterError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'ProviderRouterError';
        this.code = code;
        this.reason = message;
        this.retryable = false;
        this.userFixable = true;
        this.details = details || {};
    }
}

// Returns a validated lowercase provider id, or null when the value is absent.
// Throws unknown_provider for anything present but not routable.
function normalizeProvider(value, sourceName, origin) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        throw new ProviderRouterError(
            'unknown_provider',
            `provider from ${origin} must be a string, got ${typeof value}`,
            { sourceName, value, origin, known: KNOWN_PROVIDERS.slice() }
        );
    }
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (!KNOWN_PROVIDERS.includes(v)) {
        throw new ProviderRouterError(
            'unknown_provider',
            `unknown provider "${value}" from ${origin}; known: ${KNOWN_PROVIDERS.join(', ')}`,
            { sourceName, value, origin, known: KNOWN_PROVIDERS.slice() }
        );
    }
    return v;
}

function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (e) {
        return null;
    }
}

class ProviderRouter {
    // opts.cliProvider: string | null. null means the flag was not passed.
    // opts.defaultProvider: one of KNOWN_PROVIDERS (default 'deepseek').
    constructor(opts = {}) {
        this.cliProvider = normalizeProvider(opts.cliProvider, null, '--provider');
        this.defaultProvider = normalizeProvider(
            opts.defaultProvider === undefined ? DEFAULT_PROVIDER : opts.defaultProvider,
            null,
            'defaultProvider'
        ) || DEFAULT_PROVIDER;
    }

    // -> { provider, reason, source: 'classes' | 'cli' | 'default' }
    decide(sourceName, cls) {
        const override = normalizeProvider(cls && cls.provider, sourceName, 'classes.json');
        const cli = this.cliProvider;

        if (override && cli && override !== cli) {
            throw new ProviderRouterError(
                'conflicting_provider',
                `source "${sourceName}": classes.json override "${override}" conflicts with --provider "${cli}"; remove one.`,
                { sourceName, override, cli }
            );
        }
        if (override) {
            return {
                provider: override,
                reason: cli
                    ? `classes.json override for "${sourceName}" (matches --provider)`
                    : `classes.json override for "${sourceName}"`,
                source: 'classes',
            };
        }
        if (cli) {
            return { provider: cli, reason: '--provider flag', source: 'cli' };
        }
        return {
            provider: this.defaultProvider,
            reason: 'default provider (no classes.json override, no --provider)',
            source: 'default',
        };
    }

    // tabs: [{ id, url, provider }] as reported by the extension via /tabs.
    // Returns the single matching tab. Throws ambiguous_provider_tab on 0 or 2+.
    checkTabs(provider, tabs) {
        const p = normalizeProvider(provider, null, 'checkTabs');
        if (!p) {
            throw new ProviderRouterError(
                'unknown_provider',
                'checkTabs requires a provider',
                { value: provider, known: KNOWN_PROVIDERS.slice() }
            );
        }
        if (!Array.isArray(tabs)) {
            throw new TypeError('checkTabs: tabs must be an array');
        }
        const host = PROVIDER_HOSTS[p];
        const matches = tabs.filter((t) => t && t.provider === p && hostOf(t.url) === host);
        const summary = matches.map((t) => ({ id: t.id, url: t.url }));

        if (matches.length === 0) {
            throw new ProviderRouterError(
                'ambiguous_provider_tab',
                `no ${p} tab open (expected exactly one on ${host})`,
                { provider: p, host, count: 0, tabs: summary }
            );
        }
        if (matches.length > 1) {
            throw new ProviderRouterError(
                'ambiguous_provider_tab',
                `${matches.length} ${p} tabs open (ids ${matches.map((t) => t.id).join(', ')}); close all but one`,
                { provider: p, host, count: matches.length, tabs: summary }
            );
        }
        return matches[0];
    }
}

module.exports = {
    ProviderRouter,
    ProviderRouterError,
    KNOWN_PROVIDERS,
    DEFAULT_PROVIDER,
    PROVIDER_HOSTS,
};
