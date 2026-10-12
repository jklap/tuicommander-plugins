/** Token-free Jira REST port. The core supplies authentication and account budget. */
export class JiraError extends Error {
  constructor(status, retryAfterMs = null) {
    super(status === 429 ? 'Jira rate limit; retry later' : `Jira request failed (${status})`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createClient({ account, fetch, now = Date.now }) {
  const base = new URL(account.host);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Jira account requires an HTTP(S) site URL without credentials');
  }
  const host = base.href.replace(/\/$/, '');
  const cloud = account.kind === 'basic';
  if (!cloud && account.kind !== 'bearer') throw new Error('Jira supports Basic Cloud or Bearer Data Center accounts');
  let blockedUntil = 0;
  async function request(path, { method = 'GET', body } = {}) {
    if (now() < blockedUntil) throw new JiraError(429, blockedUntil - now());
    const response = await fetch({
      url: `${host}${path}`, method, body,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TUICommander-Jira/1.0' },
    });
    if (response.status === 429) {
      const value = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = value == null || value.trim() === '' ? NaN : Number(value);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
      blockedUntil = now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 60_000);
      throw new JiraError(429, blockedUntil - now());
    }
    if (response.status < 200 || response.status >= 300) throw new JiraError(response.status);
    return response.json;
  }
  return { host, cloud, api: `/rest/api/${cloud ? 3 : 2}`, request };
}
