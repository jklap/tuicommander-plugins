import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import plugin, { registerJiraAccounts } from './main.js';
import { accountFetch } from './runtime.js';

// Catches: sites collide or unloading retains a provider that can still write.
test('multi_site_registration_and_disposal_are_account_scoped', () => {
  const providers = new Map(); const disposed = [];
  const host = { registerWorkItemProvider(provider) {
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
    registerWorkItemProvider(provider) { live.push(provider); return { dispose() { live.splice(live.indexOf(provider), 1); } }; },
  };
  await plugin.onload(host);
  assert.deepEqual(live.map((p) => p.accountId), ['one']);
  plugin.onunload();
  assert.equal(live.length, 0);
});
