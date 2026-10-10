import assert from 'node:assert/strict';
import test from 'node:test';
import { registerJiraAccounts } from './main.js';

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
