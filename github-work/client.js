/** Account-scoped port. Authentication and request budgets belong to the host. */
export class GitHubError extends Error {
  constructor(status, retryAfter = null, message = "GitHub request failed") {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function createClient(fetch, apiUrl = "https://api.github.com") {
  const base = new URL(apiUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("GitHub API must be an HTTPS origin/path without credentials");
  }
  const root = base.href.replace(/\/$/, "");
  return {
    async request(path, method = "GET", body, signal) {
      signal?.throwIfAborted();
      const url = new URL(`${root}/${path.replace(/^\//, "")}`);
      if (url.origin !== base.origin) throw new Error("Cross-host GitHub request");
      const response = await fetch({ url: url.href, method, ...(body === undefined ? {} : { body }) });
      signal?.throwIfAborted();
      const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (response.status < 200 || response.status >= 300) {
        // Never reflect a remote body into an error: it may echo credentials or private text.
        throw new GitHubError(response.status, headers["retry-after"] ?? null);
      }
      return { json: response.json, headers };
    },
    async graphql(query, variables, signal) {
      const { json } = await this.request("graphql", "POST", { query, variables }, signal);
      if (json?.errors?.length) throw new GitHubError(200, null, "GitHub GraphQL request failed");
      if (!json?.data) throw new Error("GitHub response has no GraphQL data");
      return json.data;
    },
  };
}

export function pageNumber(cursor) {
  if (cursor === null || cursor === undefined) return 1;
  if (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error("Invalid page cursor");
  return Number(cursor);
}

export function pageSize(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Page limit must be 1–100");
  return limit;
}

export function nextPage(headers, current) {
  return /<[^>]+>;\s*rel="next"/.test(headers.link ?? "") ? String(current + 1) : null;
}
