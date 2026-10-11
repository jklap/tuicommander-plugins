import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import plugin, { registerGitLabAccounts } from './main.js';
import { accountFetch } from './runtime.js';

// Recorded from GitLab CE and scrubbed (fixtures/recorded.json, provenance inside).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recorded.json', import.meta.url), 'utf8'));
const HOST = 'https://gitlab.example.invalid:8443';
const IID = fixture.issue.iid;
const accounts = [
  { id: 'work', provider: 'gitlab', host: HOST, label: 'Work' },
  { id: 'home', provider: 'gitlab', host: 'https://gitlab.com', label: 'Home' },
  { id: 'gh', provider: 'github', host: 'https://github.com' },
];
const fetchFor = () => async (req) => {
  const path = new URL(req.url).pathname;
  const json = { [`/api/v4/projects/demo%2Fwidgets/issues/${IID}`]: fixture.issue, [`/api/v4/projects/demo%2Fwidgets/issues/${IID}/discussions`]: fixture.issueDiscussions }[path] ?? [];
  return { status: 200, headers: {}, json };
};

function fakeHost({ failAt = Infinity } = {}) {
  const live = { providers: [], resolvers: [] };
  const track = (list, value) => {
    list.push(value);
    return { dispose() { list.splice(list.indexOf(value), 1); } };
  };
  return {
    live,
    registerWorkItemProvider(provider) {
      if (live.providers.length >= failAt) throw new Error('registry full');
      return track(live.providers, provider);
    },
    registerUrlResolver: (resolver) => track(live.resolvers, resolver),
  };
}

// Catches: a second GitLab account (work and personal) overwriting the first, or a
// GitHub account handed to the GitLab provider.
test('registers_one_provider_per_gitlab_account_and_cleans_up', () => {
  const host = fakeHost();
  const registration = registerGitLabAccounts(host, accounts, fetchFor);
  assert.deepEqual(host.live.providers.map((p) => p.accountId), ['work', 'home']);
  assert.equal(host.live.resolvers.length, 1);
  registration.dispose();
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
  const failing = fakeHost({ failAt: 1 });
  assert.throws(() => registerGitLabAccounts(failing, accounts, fetchFor), /registry full/);
  assert.deepEqual(failing.live, { providers: [], resolvers: [] });
});

// Catches: a pasted issue URL that links without offering start work, or a start-work
// brief that is submitted instead of drafted.
test('pasted_issue_url_links_and_drafts_start_work', async () => {
  const host = fakeHost();
  registerGitLabAccounts(host, accounts, fetchFor);
  const resolved = await host.live.resolvers[0](fixture.issue.web_url, new AbortController().signal);
  assert.deepEqual(resolved.link.reference, { providerId: 'gitlab', accountId: 'work', id: fixture.issue.references.full });
  assert.equal(resolved.startWork.branch, `${IID}-login-fails-on-a-custom-port`);
  assert.equal(resolved.startWork.delivery, 'draft');
  assert.equal(await host.live.resolvers[0](`https://gitlab.example.invalid/demo/widgets/-/issues/${IID}`, new AbortController().signal), null);
});

// Catches: the plugin sending the request without the account (anonymous call), a non-string body
// (Rust expects a string), or a non-JSON body (job trace) throwing inside the adapter.
test('account_fetch_sends_account_serialised_body_and_keeps_text', async () => {
  const calls = [];
  const host = { httpFetch: async (url, options) => { calls.push({ url, options }); return { status: 200, headers: {}, body: calls.length === 1 ? '{"a":1}' : 'plain trace' }; } };
  const fetch = accountFetch(host, 'work');
  const first = await fetch({ url: `${HOST}/api/v4/x`, method: 'POST', body: { a: 1 }, headers: { 'Content-Type': 'application/json' } });
  assert.equal(calls[0].options.account, 'work');
  assert.equal(calls[0].options.body, '{"a":1}');
  assert.deepEqual(first.json, { a: 1 });
  const second = await fetch({ url: `${HOST}/api/v4/job/trace` });
  assert.equal(second.json, undefined);
  assert.equal(second.text, 'plain trace');
});

// Catches: the manifest missing the descriptor/net:http, which makes Rust refuse every account request.
test('manifest_declares_gitlab_account_use', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, plugin.id);
  assert.ok(manifest.capabilities.includes('net:http'));
  assert.deepEqual(manifest.providers.map((p) => p.id), ['gitlab']);
  assert.deepEqual(manifest.providers[0].kinds, ['bearer']);
});

// Catches: activation without configuration registering anything, or staying silent about why.
test('onload_without_config_registers_nothing_and_says_why', async () => {
  const logs = [];
  const host = { ...fakeHost(), log: (level, message) => logs.push([level, message]), invoke: async () => null };
  await plugin.onload(host);
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /config\.json/);
});

// Catches: configured accounts not registered with their project, or leaked after unload.
test('onload_registers_configured_accounts_and_unload_removes_them', async () => {
  const config = { accounts: [{ id: 'work', host: HOST, project: 'demo/widgets', login: 'me' }] };
  const host = { ...fakeHost(), log() {}, httpFetch: async () => ({ status: 200, headers: {}, body: '[]' }), invoke: async (cmd, args) => {
    assert.deepEqual([cmd, args], ['read_plugin_data', { pluginId: 'gitlab', path: 'config.json' }]);
    return JSON.stringify(config);
  } };
  await plugin.onload(host);
  assert.deepEqual(host.live.providers.map((p) => p.accountId), ['work']);
  assert.equal(host.live.resolvers.length, 1);
  plugin.onunload();
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
});
