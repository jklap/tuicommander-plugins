import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import plugin, { registerJiraAccounts } from './main.js';
import { accountFetch } from './runtime.js';

// Catches: sites collide or unloading retains a provider that can still write.
test('multi_site_registration_and_disposal_are_account_scoped', () => {
  const providers = new Map(); const disposed = [];
  const host = { registerUrlResolver() { return { dispose() {} }; }, registerWorkItemProvider(provider) {
    providers.set(provider.accountId, provider);
    return { dispose() { disposed.push(provider.accountId); providers.delete(provider.accountId); } };
  } };
  const registration = registerJiraAccounts(host, [
    { id: 'one', provider: 'jira', host: 'https://one.example.invalid', kind: 'basic' },
    { id: 'two', provider: 'jira', host: 'https://two.example.invalid:8443/jira', kind: 'bearer' },
    { id: 'github', provider: 'github' },
  ], () => async () => { throw new Error('No request expected during registration'); });
  assert.equal(providers.size, 2);
  assert.equal(providers.get('one').resolveUrl('https://one.example.invalid/browse/A-7').accountId, 'one');
  assert.equal(providers.get('two').resolveUrl('https://two.example.invalid/jira/browse/A-7'), null);
  registration.dispose(); registration.dispose();
  assert.equal(providers.size, 0);
  assert.deepEqual(disposed, ['two', 'one']);
});

// Catches: partial activation leaks registrations after a malformed account.
test('failed_multi_site_registration_cleans_up_previous_providers', () => {
  let active = 0;
  assert.throws(() => registerJiraAccounts({ registerWorkItemProvider() { active++; return { dispose() { active--; } }; } }, [
    { id: 'one', provider: 'jira', host: 'https://one.example.invalid', kind: 'basic' },
    { id: 'two', provider: 'jira', host: 'file:///tmp', kind: 'basic' },
  ], () => async () => {}), /HTTP/);
  assert.equal(active, 0);
});

// Catches: the plugin sending the request without the account (anonymous call), a non-string body
// (Rust expects a string), or a non-JSON body throwing inside the adapter.
test('account_fetch_sends_account_serialised_body_and_keeps_text', async () => {
  const calls = [];
  const host = { httpFetch: async (url, options) => { calls.push({ url, options }); return { status: 200, headers: {}, body: calls.length === 1 ? '{"a":1}' : '<html>' }; } };
  const fetch = accountFetch(host, 'one');
  const first = await fetch({ url: 'https://one.example.invalid/rest/api/3/issue', method: 'POST', body: { fields: {} }, headers: { 'User-Agent': 'x' } });
  assert.equal(calls[0].options.account, 'one');
  assert.equal(calls[0].options.body, '{"fields":{}}');
  assert.equal(calls[0].options.headers['User-Agent'], 'x');
  assert.deepEqual(first.json, { a: 1 });
  const second = await fetch({ url: 'https://one.example.invalid/x' });
  assert.equal(second.json, undefined);
  assert.equal(second.text, '<html>');
});

// Catches: the manifest missing the descriptor/net:http, which makes Rust refuse every account request.
test('manifest_declares_jira_account_use', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, plugin.id);
  assert.ok(manifest.capabilities.includes('net:http'));
  // Rust rejects net:http with an empty allowedUrls list, even when requests use an account.
  assert.ok(manifest.allowedUrls.length > 0);
  assert.deepEqual(manifest.providers.map((p) => p.id), ['jira']);
  assert.deepEqual(manifest.providers[0].kinds, ['basic', 'bearer']);
});

// Catches: activation without configuration registering anything, or staying silent about why.
test('onload_without_config_registers_nothing_and_says_why', async () => {
  const logs = []; let registered = 0;
  const host = { log: (level, message) => logs.push([level, message]), invoke: async () => null, registerWorkItemProvider() { registered++; } };
  await plugin.onload(host);
  assert.equal(registered, 0);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /config\.json/);
});

// Catches: configured sites not registered with their kind, or leaked after unload.
test('onload_registers_configured_accounts_and_unload_removes_them', async () => {
  const live = [];
  const host = {
    log() {},
    invoke: async (cmd, args) => {
      assert.deepEqual([cmd, args], ['read_plugin_data', { pluginId: 'jira', path: 'config.json' }]);
      return JSON.stringify({ accounts: [{ id: 'one', host: 'https://one.example.invalid', kind: 'basic', projectId: '10000' }] });
    },
    httpFetch: async () => { throw new Error('No request expected during registration'); },
    registerUrlResolver() { return { dispose() {} }; },
    registerWorkItemProvider(provider) { live.push(provider); return { dispose() { live.splice(live.indexOf(provider), 1); } }; },
  };
  await plugin.onload(host);
  assert.deepEqual(live.map((p) => p.accountId), ['one']);
  plugin.onunload();
  assert.equal(live.length, 0);
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cloud.json', import.meta.url), 'utf8'));
const ok = (json) => ({ status: 200, headers: {}, json: structuredClone(json) });
const issueFetch = (calls) => async (req) => {
  calls.push(req.url);
  if (req.url.includes('/transitions')) return ok(fixture.transitions);
  if (req.url.includes('/comment')) return ok(fixture.comments);
  if (req.url.includes('/issue/DEMO-7')) return ok(fixture.issue);
  throw new Error(`Unexpected request: ${req.url}`);
};
function registerWithResolver(accounts, calls = []) {
  const resolvers = []; let disposed = 0;
  const host = {
    registerWorkItemProvider() { return { dispose() {} }; },
    registerUrlResolver(resolver) { resolvers.push(resolver); return { dispose() { disposed++; } }; },
  };
  const registration = registerJiraAccounts(host, accounts, () => issueFetch(calls));
  return { resolvers, registration, disposed: () => disposed };
}
const signal = new AbortController().signal;

// Catches: provider.resolveUrl never reaching the palette because main.js does not register a resolver.
test('pasted_browse_url_resolves_to_link_and_start_work', async () => {
  const { resolvers } = registerWithResolver([{ id: 'one', provider: 'jira', host: 'https://jira.example.invalid', kind: 'basic' }]);
  assert.equal(resolvers.length, 1);
  const resolved = await resolvers[0]('https://jira.example.invalid/browse/DEMO-7', signal);
  assert.deepEqual(resolved.link.reference, { providerId: 'jira', accountId: 'one', id: 'DEMO-7' });
  assert.equal(resolved.link.key, 'DEMO-7');
  assert.equal(resolved.startWork.delivery, 'draft');
  assert.match(resolved.startWork.branch, /^DEMO-7-/);
  assert.match(resolved.startWork.prompt, /DEMO-7/);
});

// Catches: the Jira resolver claiming (or fetching for) URLs of another host such as GitHub.
test('url_of_another_host_is_not_claimed_and_costs_no_request', async () => {
  const calls = [];
  const { resolvers } = registerWithResolver([{ id: 'one', provider: 'jira', host: 'https://jira.example.invalid', kind: 'basic' }], calls);
  assert.equal(await resolvers[0]('https://github.com/acme/widgets/issues/7', signal), null);
  assert.equal(await resolvers[0]('https://other.example.invalid/browse/DEMO-7', signal), null);
  assert.deepEqual(calls, []);
});

// Catches: a Data Center context path stripped, so /jira/browse/KEY resolves for no account.
test('data_center_url_with_context_path_resolves_for_its_account_only', async () => {
  const { resolvers } = registerWithResolver([
    { id: 'cloud', provider: 'jira', host: 'https://jira.example.invalid', kind: 'basic' },
    { id: 'dc', provider: 'jira', host: 'https://dc.example.invalid:8443/jira', kind: 'bearer' },
  ]);
  const resolved = await resolvers[0]('https://dc.example.invalid:8443/jira/browse/DEMO-7', signal);
  assert.equal(resolved.link.reference.accountId, 'dc');
  assert.equal(await resolvers[0]('https://dc.example.invalid:8443/browse/DEMO-7', signal), null);
});

// Catches: the resolver leaking after unload, or registered with no Jira account.
test('url_resolver_is_disposed_with_accounts_and_skipped_without_them', () => {
  const none = registerWithResolver([{ id: 'github', provider: 'github' }]);
  assert.equal(none.resolvers.length, 0);
  const some = registerWithResolver([{ id: 'one', provider: 'jira', host: 'https://jira.example.invalid', kind: 'basic' }]);
  some.registration.dispose(); some.registration.dispose();
  assert.equal(some.disposed(), 1);
});
