/** Token-free GitLab REST v4 port. The core injects the PAT and owns the account budget. */
export class GitLabError extends Error {
  constructor(status, retryAfterMs = null, message = null) {
    super(message ?? (status === 429 ? 'GitLab rate limit; retry later' : `GitLab request failed (${status})`));
    this.name = 'GitLabError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The account host is the identity of a GitLab instance: scheme, hostname, port and
 * relative URL root together. `https://git.example` and `https://git.example:8443`
 * are two instances, so every comparison uses the full base, never the hostname.
 */
export function instanceBase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('GitLab account requires an HTTP(S) instance URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('GitLab account requires an HTTP(S) instance URL without credentials');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const lower = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

export function createClient({ account, fetch, now = Date.now }) {
  const base = instanceBase(account.host);
  const api = `${base}/api/v4`;
  let blockedUntil = 0;
  async function request(path, { method = 'GET', body, signal, text = false } = {}) {
    signal?.throwIfAborted();
    if (now() < blockedUntil) throw new GitLabError(429, blockedUntil - now());
    const url = new URL(`${api}/${path.replace(/^\//, '')}`);
    if (!url.href.startsWith(`${api}/`)) throw new Error('Cross-instance GitLab request');
    const response = await fetch({
      url: url.href, method, ...(body === undefined ? {} : { body }),
      headers: { Accept: text ? 'text/plain' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    });
    signal?.throwIfAborted();
    const headers = lower(response.headers);
    if (response.status === 429) {
      const value = headers['retry-after'];
      const seconds = value == null || value.trim() === '' ? NaN : Number(value);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
      blockedUntil = now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 60_000);
      throw new GitLabError(429, blockedUntil - now());
    }
    // Never reflect a remote body into an error: it may echo private text.
    if (response.status < 200 || response.status >= 300) throw new GitLabError(response.status);
    return { json: response.json, text: response.text ?? null, headers };
  }
  return { base, api, request };
}

/** Offset pagination: a cursor is a page number; GitLab announces the next one in `x-next-page`. */
export function pageNumber(cursor) {
  if (cursor == null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(cursor)) throw new Error('Invalid GitLab page cursor');
  return Number(cursor);
}

export function pageSize(limit) {
  return Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
}

export const nextCursor = (headers) => (/^[1-9]\d*$/.test(headers['x-next-page'] ?? '') ? headers['x-next-page'] : null);
