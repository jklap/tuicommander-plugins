import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from './client.js';

const failWith = (status, headers, json = {}) => async () => ({ status, headers, json });
const caught = async (fetch) => createClient(fetch).request('/rate_limit').then(() => null, (error) => error);

// Catches: a primary-limit 403 reads as a permission error, so the UI shows no retry time.
test('a 403 with no quota left carries resetAt from x-ratelimit-reset', async () => {
  const error = await caught(failWith(403, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1900000000' }));
  assert.equal(error.status, 403);
  assert.equal(error.resetAt, '1900000000');
});

// Catches: a permission 403 that still has quota is mistaken for a rate limit.
test('a 403 with quota left has no resetAt', async () => {
  const error = await caught(failWith(403, { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1900000000' }));
  assert.equal(error.resetAt, null);
});

// Catches: the gateway's synthetic 429 reaches the UI as a plain failure instead of the typed rate_limited error.
test('the gateway 429 becomes the typed rate_limited error', async () => {
  const before = Date.now();
  const error = await caught(failWith(429, { 'x-tuic-gateway': 'rate_limited', 'retry-after': '90' }));
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.bucket, null);
  assert.ok(error.retry_at >= before + 90_000 && error.retry_at <= Date.now() + 90_000);
});

// Catches: an upstream 500 is typed as a limit.
test('other failures stay untyped', async () => {
  const error = await caught(failWith(500, {}));
  assert.equal(error.kind, undefined);
});
