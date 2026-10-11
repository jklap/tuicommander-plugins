import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import plugin, { registerGitLabAccounts } from './main.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/unrecorded.json', import.meta.url), 'utf8'));
const accounts = [
  { id: 'work', provider: 'gitlab', host: 'https://gitlab.example.invalid:8443', label: 'Work' },
  { id: 'home', provider: 'gitlab', host: 'https://gitlab.com', label: 'Home' },
  { id: 'gh', provider: 'github', host: 'https://github.com' },
];
const fetchFor = () => async (req) => {
  const path = new URL(req.url).pathname;
  const json = { '/api/v4/projects/demo%2Fwidgets/issues/12': fixture.issue, '/api/v4/projects/demo%2Fwidgets/issues/12/discussions': [] }[path] ?? [];
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
  assert.deepEqual(resolved.link.reference, { providerId: 'gitlab', accountId: 'work', id: 'demo/widgets#12' });
  assert.equal(resolved.startWork.branch, '12-login-fails-on-a-custom-port');
  assert.equal(resolved.startWork.delivery, 'draft');
  assert.equal(await host.live.resolvers[0]('https://gitlab.example.invalid/demo/widgets/-/issues/12', new AbortController().signal), null);
});

// Catches: the shipped plugin activating with an unauthenticated or token-bearing path
// before the core account HTTP integration exists.
test('onload_registers_nothing_without_account_http', () => {
  const logs = [];
  const host = { ...fakeHost(), log: (level, message) => logs.push([level, message]) };
  plugin.onload(host);
  assert.equal(host.live.providers.length, 0);
  assert.equal(logs[0][0], 'warn');
});
