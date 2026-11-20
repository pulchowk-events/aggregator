// scripts/batch/lib/provider-router.js
//
// The only place the aggregator decides which LLM provider handles a source.
//
// The set of routable providers is NOT hardcoded here. It comes from the
// deepseek-connect server (GET /providers) through ProviderRouter.fromServer(),
// which builds one frozen registry per run:
//   - built-ins (deepseek, qwen) keep their hosts in this file, because the
//     server's rows for them carry no hosts;
//   - config providers (providers/<name>.js) take their hosts from
//     definition.domains.
//
// decide(sourceName, cls) resolves, in order:
//   1. classes.json override  (cls.provider)
//   2. --provider CLI flag    (opts.cliProvider; null means "not passed")
//   3. defaultProvider        (constructor option, default 'deepseek')
//
// It REFUSES instead of guessing:
//   unknown_provider       value is not in the registry
//   conflicting_provider   classes override and --provider are both set and differ
//   invalid_registry       the server's provider list breaks an isolation rule
//   providers_unavailable  GET /providers failed; there is no fallback list
//
// checkTabs(provider, tabs) is the preflight against the extension's live tab
// inventory (client.tabs().tabs). It requires exactly one tab for the provider,
// counted across ALL of the provider's domains and matched on exact hostname,
// and throws ambiguous_provider_tab on zero or 2+. A tab whose provider label
// and hostname disagree is not counted (fail closed). The extension raises the
// same code for the same condition.
//
// Isolation rules enforced when the registry is built (invalid_registry):
//   - a config provider may not take a built-in or reserved name;
//   - no hostname may belong to two providers (config vs built-in or config
//     vs config), so a tab can never be claimed by two providers;
//   - names and domains are re-validated here, not trusted from the server.
// The registry is deep-frozen and copied from the server's rows: nothing the
// server sends later (or any caller) can change routing mid-run.

'use strict';

const BUILTIN_HOSTS = Object.freeze({
    deepseek: Object.freeze(['chat.deepseek.com']),
    qwen: Object.freeze(['chat.qwen.ai']),
    chatgpt: Object.freeze(['chatgpt.com']),
});
const BUILTIN_PROVIDERS = Object.freeze(Object.keys(BUILTIN_HOSTS));
// Has a domain in the extension but no module, so it is never routable.
const RESERVED_NAMES = Object.freeze(['tongyi']);
const DEFAULT_PROVIDER = 'deepseek';

// Same shapes the extension (shared.js) and the server accept.
const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Own-property test. Provider names are data: 'constructor' must not resolve
// through Object.prototype.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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

function deepFreeze(o) {
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    }
    return Object.freeze(o);
}

const bad = (message, details) => new ProviderRouterError('invalid_registry', message, details);

// rows: the `providers` array of GET /providers:
//   [{ name, file, kind: 'built-in' | 'config', definition: {...} | null }]
// -> frozen { hosts: {name: [hostname]}, unroutable: {name: reason}, names: [name] }
function buildRegistry(rows) {
    if (!Array.isArray(rows)) {
        throw new ProviderRouterError('providers_unavailable', 'GET /providers returned no providers array', {});
    }
    const hosts = Object.create(null);
    const unroutable = Object.create(null);
    const owner = Object.create(null);
    const claim = (name, host) => {
        if (own(owner, host) && owner[host] !== name) {
            throw bad(
                'host "' + host + '" is claimed by both "' + owner[host] + '" and "' + name + '"',
                { host, providers: [owner[host], name] }
            );
        }
        owner[host] = name;
    };

    for (const name of BUILTIN_PROVIDERS) {
        hosts[name] = BUILTIN_HOSTS[name].slice();
        for (const h of hosts[name]) claim(name, h);
    }

    for (const row of rows) {
        if (!row || typeof row.name !== 'string') throw bad('provider row without a name', {});
        const name = row.name;

        if (row.kind === 'built-in') {
            if (!own(BUILTIN_HOSTS, name)) unroutable[name] = 'built-in with no host known to this aggregator';
            continue;
        }
        if (row.kind !== 'config') {
            unroutable[name] = 'unknown kind "' + row.kind + '"';
            continue;
        }

        if (own(BUILTIN_HOSTS, name) || RESERVED_NAMES.includes(name)) {
            throw bad('config provider "' + name + '" shadows a built-in or reserved provider', { name });
        }
        if (!NAME_RE.test(name)) throw bad('provider name "' + name + '" is not a valid name', { name });
        if (own(hosts, name) || own(unroutable, name)) throw bad('provider "' + name + '" is listed twice', { name });

        const def = row.definition;
        if (!def || !Array.isArray(def.domains) || def.domains.length === 0) {
            unroutable[name] = 'no definition (hand-written file); only generated providers are routable';
            continue;
        }
        const domains = Array.from(new Set(
            def.domains.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : d))
        ));
        for (const d of domains) {
            if (typeof d !== 'string' || !HOST_RE.test(d)) {
                throw bad('provider "' + name + '" has an invalid domain ' + JSON.stringify(d), { name, domain: d });
            }
        }
        hosts[name] = domains;
        for (const d of domains) claim(name, d);
    }

    return deepFreeze({ hosts, unroutable, names: Object.keys(hosts) });
}

// Built-ins only. Used when no registry is injected; the paste flow always
// injects one from the server.
const STATIC_REGISTRY = buildRegistry([]);

// Returns a validated lowercase provider id, or null when the value is absent.
// Throws unknown_provider for anything present but not in the registry.
function normalizeProvider(value, sourceName, origin, registry) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        throw new ProviderRouterError(
            'unknown_provider',
            'provider from ' + origin + ' must be a string, got ' + typeof value,
            { sourceName, value, origin, known: registry.names.slice() }
        );
    }
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (!own(registry.hosts, v)) {
        const why = own(registry.unroutable, v)
            ? ' (listed by the server but not routable: ' + registry.unroutable[v] + ')'
            : '';
        throw new ProviderRouterError(
            'unknown_provider',
            'unknown provider "' + value + '" from ' + origin + why + '; known: ' + registry.names.join(', '),
            { sourceName, value, origin, known: registry.names.slice() }
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

function is404(err) {
    if (!err) return false;
    const d = err.details;
    return err.http === 404 || err.status === 404 || err.statusCode === 404 ||
        err.code === 'not_found' || err.reason === 'not_found' ||
        !!(d && (d.http === 404 || d.error === 'not_found'));
}

function providersUnavailable(err) {
    const cause = err && (err.reason || err.message) ? String(err.reason || err.message) : String(err);
    if (is404(err)) {
        return new ProviderRouterError(
            'providers_unavailable',
            'the deepseek-connect server predates GET /providers; update deepseek-connect and restart the server (' + cause + ')',
            { cause }
        );
    }
    return new ProviderRouterError(
        'providers_unavailable',
        'cannot fetch the provider list from the deepseek-connect server (GET /providers): ' + cause,
        { cause }
    );
}

class ProviderRouter {
    // opts.registry: from buildRegistry(); defaults to the built-ins only.
    // opts.cliProvider: string | null. null means the flag was not passed.
    // opts.defaultProvider: a provider in the registry (default 'deepseek').
    constructor(opts = {}) {
        this.registry = opts.registry || STATIC_REGISTRY;
        this.cliProvider = normalizeProvider(opts.cliProvider, null, '--provider', this.registry);
        this.defaultProvider = normalizeProvider(
            opts.defaultProvider === undefined ? DEFAULT_PROVIDER : opts.defaultProvider,
            null,
            'defaultProvider',
            this.registry
        ) || DEFAULT_PROVIDER;
    }

    // Builds the registry from GET /providers. Hard-fails (providers_unavailable)
    // when the server cannot answer; there is no fallback provider list.
    // client: deepseek-connect createClient() result (needs .providers()).
    static async fromServer(client, opts = {}) {
        if (!client || typeof client.providers !== 'function') {
            throw new TypeError('ProviderRouter.fromServer: client.providers() is required');
        }
        let res;
        try {
            res = await client.providers();
        } catch (err) {
            throw providersUnavailable(err);
        }
        const registry = buildRegistry(res && res.providers);
        return new ProviderRouter(Object.assign({}, opts, { registry }));
    }

    names() {
        return this.registry.names.slice();
    }

    // -> { provider, reason, source: 'classes' | 'cli' | 'default' }
    decide(sourceName, cls) {
        const override = normalizeProvider(cls && cls.provider, sourceName, 'classes.json', this.registry);
        const cli = this.cliProvider;

        if (override && cli && override !== cli) {
            throw new ProviderRouterError(
                'conflicting_provider',
                'source "' + sourceName + '": classes.json override "' + override + '" conflicts with --provider "' + cli + '"; remove one.',
                { sourceName, override, cli }
            );
        }
        if (override) {
            return {
                provider: override,
                reason: cli
                    ? 'classes.json override for "' + sourceName + '" (matches --provider)'
                    : 'classes.json override for "' + sourceName + '"',
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
        const p = normalizeProvider(provider, null, 'checkTabs', this.registry);
        if (!p) {
            throw new ProviderRouterError(
                'unknown_provider',
                'checkTabs requires a provider',
                { value: provider, known: this.registry.names.slice() }
            );
        }
        if (!Array.isArray(tabs)) {
            throw new TypeError('checkTabs: tabs must be an array');
        }
        const hosts = this.registry.hosts[p];
        const matches = tabs.filter((t) => t && t.provider === p && hosts.includes(hostOf(t.url)));
        const summary = matches.map((t) => ({ id: t.id, url: t.url }));
        const where = hosts.join(' or ');

        if (matches.length === 0) {
            throw new ProviderRouterError(
                'ambiguous_provider_tab',
                'no ' + p + ' tab open (expected exactly one on ' + where + ')',
                { provider: p, hosts: hosts.slice(), count: 0, tabs: summary }
            );
        }
        if (matches.length > 1) {
            throw new ProviderRouterError(
                'ambiguous_provider_tab',
                matches.length + ' ' + p + ' tabs open (ids ' + matches.map((t) => t.id).join(', ') + '); close all but one',
                { provider: p, hosts: hosts.slice(), count: matches.length, tabs: summary }
            );
        }
        return matches[0];
    }
}

module.exports = {
    ProviderRouter,
    ProviderRouterError,
    buildRegistry,
    BUILTIN_PROVIDERS,
    DEFAULT_PROVIDER,
};
