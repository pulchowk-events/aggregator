'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRouter, ProviderRouterError, buildRegistry } = require('./provider-router');

const is = (code) => (e) => e instanceof ProviderRouterError && e.code === code;
const row = (name, domains) => ({
    name,
    file: 'providers/' + name + '.js',
    kind: 'config',
    definition: { schema: 1, name, label: name, domains },
});
const BUILT = [
    { name: 'deepseek', file: 'providers/deepseek.js', kind: 'built-in', definition: null },
    { name: 'qwen', file: 'providers/qwen.js', kind: 'built-in', definition: null },
];
const withGlm = () => BUILT.concat([row('glm', ['chat.z.ai'])]);
const tab = (id, provider, url) => ({ id, provider, url });
const okClient = (rows) => ({ providers: async () => ({ ok: true, providers: rows }) });

test('built-in registry: deepseek and qwen route, default is deepseek', () => {
    const r = new ProviderRouter();
    assert.deepEqual(r.names(), ['deepseek', 'qwen', 'chatgpt']);
    assert.equal(r.decide('s', {}).provider, 'deepseek');
    assert.equal(r.decide('s', { provider: 'qwen' }).provider, 'qwen');
});

test('a config provider routes from a classes override and from --provider', () => {
    const registry = buildRegistry(withGlm());
    const viaClasses = new ProviderRouter({ registry }).decide('s', { provider: 'glm' });
    assert.equal(viaClasses.provider, 'glm');
    assert.equal(viaClasses.source, 'classes');
    const viaCli = new ProviderRouter({ registry, cliProvider: 'GLM' }).decide('s', {});
    assert.equal(viaCli.provider, 'glm');
    assert.equal(viaCli.source, 'cli');
});

test('an unknown provider is refused and the known list includes config providers', () => {
    const registry = buildRegistry(withGlm());
    const r = new ProviderRouter({ registry });
    assert.throws(
        () => r.decide('s', { provider: 'nope' }),
        (e) => is('unknown_provider')(e) && /glm/.test(e.message) && e.details.known.includes('glm')
    );
    assert.throws(() => new ProviderRouter({ registry, cliProvider: 'nope' }), is('unknown_provider'));
});

test('a classes override that conflicts with --provider is still refused', () => {
    const registry = buildRegistry(withGlm());
    const r = new ProviderRouter({ registry, cliProvider: 'deepseek' });
    assert.throws(() => r.decide('s', { provider: 'glm' }), is('conflicting_provider'));
    assert.equal(r.decide('s', { provider: 'deepseek' }).provider, 'deepseek');
});

test('a server row without a definition is listed but not routable', () => {
    const hand = { name: 'hand', file: 'providers/hand.js', kind: 'config', definition: null };
    const registry = buildRegistry(BUILT.concat([hand]));
    const r = new ProviderRouter({ registry });
    assert.deepEqual(r.names(), ['deepseek', 'qwen', 'chatgpt']);
    assert.throws(
        () => r.decide('s', { provider: 'hand' }),
        (e) => is('unknown_provider')(e) && /not routable/.test(e.message)
    );
});

test('a config provider cannot shadow a built-in or the reserved tongyi', () => {
    assert.throws(() => buildRegistry(BUILT.concat([row('deepseek', ['x.example.com'])])), is('invalid_registry'));
    assert.throws(() => buildRegistry(BUILT.concat([row('qwen', ['x.example.com'])])), is('invalid_registry'));
    assert.throws(() => buildRegistry(BUILT.concat([row('tongyi', ['x.example.com'])])), is('invalid_registry'));
});

test('host collisions and duplicate names are refused', () => {
    assert.throws(
        () => buildRegistry(BUILT.concat([row('evil', ['chat.deepseek.com'])])),
        (e) => is('invalid_registry')(e) && e.details.host === 'chat.deepseek.com'
    );
    assert.throws(() => buildRegistry(BUILT.concat([row('evil', ['CHAT.DEEPSEEK.COM'])])), is('invalid_registry'));
    assert.throws(
        () => buildRegistry([row('aa', ['shared.example.com']), row('bb', ['shared.example.com'])]),
        is('invalid_registry')
    );
    assert.throws(
        () => buildRegistry([row('aa', ['a.example.com']), row('aa', ['b.example.com'])]),
        (e) => is('invalid_registry')(e) && /listed twice/.test(e.message)
    );
});

test('bad names and domains are refused; prototype names are only routable when registered', () => {
    for (const name of ['Bad Name', '../x', 'a'.repeat(40)]) {
        assert.throws(() => buildRegistry([row(name, ['x.example.com'])]), is('invalid_registry'), name);
    }
    for (const d of ['localhost', '127.0.0.1', 'https://x.example.com', 'x.example.com:8443', '*.example.com']) {
        assert.throws(() => buildRegistry([row('okname', [d])]), is('invalid_registry'), d);
    }
    const r = new ProviderRouter();
    for (const p of ['constructor', '__proto__', 'toString']) {
        assert.throws(() => r.decide('s', { provider: p }), is('unknown_provider'), p);
    }
    assert.doesNotThrow(() => buildRegistry(BUILT.concat([row('constructor', ['c.example.com'])])));
});

test('checkTabs: exactly one tab on the provider host', () => {
    const r = new ProviderRouter({ registry: buildRegistry(withGlm()) });
    const found = r.checkTabs('glm', [
        tab(7, 'glm', 'https://chat.z.ai/c/1'),
        tab(8, 'deepseek', 'https://chat.deepseek.com/'),
    ]);
    assert.equal(found.id, 7);
    assert.throws(() => r.checkTabs('glm', []), (e) => is('ambiguous_provider_tab')(e) && e.details.count === 0);
    assert.throws(
        () => r.checkTabs('glm', [tab(1, 'glm', 'https://chat.z.ai/a'), tab(2, 'glm', 'https://chat.z.ai/b')]),
        (e) => is('ambiguous_provider_tab')(e) && e.details.count === 2 && /ids 1, 2/.test(e.message)
    );
});

test('checkTabs counts across all domains of a multi-domain provider', () => {
    const r = new ProviderRouter({
        registry: buildRegistry(BUILT.concat([row('multi', ['a.example.com', 'b.example.org'])])),
    });
    assert.equal(r.checkTabs('multi', [tab(1, 'multi', 'https://a.example.com/x')]).id, 1);
    assert.throws(
        () => r.checkTabs('multi', [tab(1, 'multi', 'https://a.example.com/x'), tab(2, 'multi', 'https://b.example.org/y')]),
        (e) => is('ambiguous_provider_tab')(e) && e.details.count === 2
    );
});

test('checkTabs fails closed on mislabelled tabs', () => {
    const r = new ProviderRouter({ registry: buildRegistry(withGlm()) });
    assert.throws(
        () => r.checkTabs('glm', [tab(1, 'glm', 'https://chat.deepseek.com/')]),
        (e) => is('ambiguous_provider_tab')(e) && e.details.count === 0
    );
    assert.throws(
        () => r.checkTabs('glm', [tab(1, 'deepseek', 'https://chat.z.ai/')]),
        (e) => is('ambiguous_provider_tab')(e) && e.details.count === 0
    );
});

test('the registry is frozen and detached from the server rows', () => {
    const rows = withGlm();
    const reg = buildRegistry(rows);
    assert.ok(Object.isFrozen(reg) && Object.isFrozen(reg.hosts) && Object.isFrozen(reg.hosts.glm));
    assert.throws(() => { reg.hosts.glm.push('evil.example.com'); }, TypeError);
    rows[2].definition.domains.push('evil.example.com');
    const r = new ProviderRouter({ registry: reg });
    assert.throws(
        () => r.checkTabs('glm', [tab(1, 'glm', 'https://evil.example.com/')]),
        is('ambiguous_provider_tab')
    );
});

test('fromServer builds the router from GET /providers', async () => {
    const r = await ProviderRouter.fromServer(okClient(withGlm()), { cliProvider: 'glm' });
    assert.deepEqual(r.names(), ['deepseek', 'qwen', 'chatgpt', 'glm']);
    assert.equal(r.decide('s', {}).provider, 'glm');
});

test('fromServer: a 404 says the server predates /providers', async () => {
    const client = {
        providers: async () => {
            const e = new Error('not_found');
            e.reason = 'not_found';
            e.http = 404;
            throw e;
        },
    };
    await assert.rejects(
        () => ProviderRouter.fromServer(client),
        (e) => is('providers_unavailable')(e) && /predates GET \/providers/.test(e.message)
    );
});

test('fromServer: any other failure hard-fails with the cause and no fallback', async () => {
    const client = {
        providers: async () => { throw new Error('server not listening on 127.0.0.1:7331'); },
    };
    await assert.rejects(
        () => ProviderRouter.fromServer(client),
        (e) => is('providers_unavailable')(e) && !/predates/.test(e.message) && /not listening/.test(e.message)
    );
});

test('fromServer: a malformed response hard-fails', async () => {
    await assert.rejects(
        () => ProviderRouter.fromServer({ providers: async () => ({ ok: true }) }),
        is('providers_unavailable')
    );
    await assert.rejects(
        () => ProviderRouter.fromServer({ providers: async () => ({ ok: true, providers: 'x' }) }),
        is('providers_unavailable')
    );
});

test('fromServer: an unknown --provider is refused after the fetch', async () => {
    await assert.rejects(
        () => ProviderRouter.fromServer(okClient(BUILT), { cliProvider: 'glm' }),
        (e) => is('unknown_provider')(e) && /--provider/.test(e.message)
    );
});

test('the default provider must exist in the registry', () => {
    assert.throws(
        () => new ProviderRouter({ registry: buildRegistry(BUILT), defaultProvider: 'glm' }),
        is('unknown_provider')
    );
    const r = new ProviderRouter({ registry: buildRegistry(withGlm()), defaultProvider: 'glm' });
    assert.equal(r.decide('s', {}).provider, 'glm');
});

test('chatgpt is a built-in routed on chatgpt.com only', () => {
    const CG = { name: 'chatgpt', file: 'providers/chatgpt.js', kind: 'built-in', definition: null };
    const registry = buildRegistry(BUILT.concat([CG]));
    assert.deepEqual(Array.from(registry.hosts.chatgpt), ['chatgpt.com']);
    assert.equal(Object.keys(registry.unroutable).includes('chatgpt'), false);
    const r = new ProviderRouter({ registry });
    assert.equal(r.decide('s', { provider: 'chatgpt' }).provider, 'chatgpt');
    assert.equal(r.checkTabs('chatgpt', [tab(1, 'chatgpt', 'https://chatgpt.com/c/1')]).id, 1);
    assert.throws(
        () => r.checkTabs('chatgpt', [tab(2, 'chatgpt', 'https://chat.openai.com/')]),
        (e) => is('ambiguous_provider_tab')(e) && e.details.count === 0
    );
    assert.throws(() => buildRegistry(BUILT.concat([CG, row('evil', ['chatgpt.com'])])), is('invalid_registry'));
    assert.throws(() => buildRegistry(BUILT.concat([row('chatgpt', ['x.example.com'])])), is('invalid_registry'));
});
