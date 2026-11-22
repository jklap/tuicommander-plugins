import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from './client.js';

const account = { id: 'a', host: 'https://gitlab.example.invalid', kind: 'basic', token: 'x' };

// Catches: the gateway's synthetic 429 reaches the UI as a plain failure instead of the typed rate_limited error.
test('the gateway 429 becomes the typed rate_limited error', async () => {
  const fetch = async () => ({ status: 429, headers: { 'x-tuic-gateway': 'rate_limited', 'retry-after': '90' } });
  const before = Date.now();
  const error = await createClient({ account, fetch }).request('/x').then(() => null, (e) => e);
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.bucket, null);
  assert.ok(error.retry_at >= before + 90_000 && error.retry_at <= Date.now() + 90_000);
});

// Catches: an upstream 500 is typed as a limit.
test('other failures stay untyped', async () => {
  const fetch = async () => ({ status: 500, headers: {} });
  const error = await createClient({ account, fetch }).request('/x').then(() => null, (e) => e);
  assert.equal(error.kind, undefined);
});
