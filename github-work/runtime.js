/** Fetch port over host.httpFetch: Rust injects the account credential, the plugin never holds a token. */
export function accountFetch(host, accountId) {
  return async ({ url, method = "GET", headers = {}, body }) => {
    const payload = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
    const response = await host.httpFetch(url, {
      method,
      headers: {
        "User-Agent": "TUICommander-github-work",
        Accept: "application/vnd.github+json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: payload }),
      account: accountId,
    });
    let json;
    try {
      json = JSON.parse(response.body);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json, text: response.body };
  };
}

/** Plugin configuration from data/work-items.json, or null when the user has not written one. */
export async function readConfig(host, pluginId) {
  const raw = await host.invoke("read_plugin_data", { pluginId, path: "work-items.json" });
  return raw ? JSON.parse(raw) : null;
}

/** B6/B7 stay core-owned, bound to this provider account rather than a local repo default. */
export function accountCore(host, accountId) {
  const check = (reference, signal) => {
    signal?.throwIfAborted();
    if (reference?.providerId !== "github" || reference.accountId !== accountId)
      throw new Error("GitHub account mismatch");
  };
  return {
    async reviewThreads(reference, cursor, _limit, signal) {
      check(reference, signal);
      const result = await host.githubReviewThreads(accountId, reference, cursor);
      signal?.throwIfAborted();
      return result;
    },
    async prAction(reference, action, payload = {}, signal) {
      check(reference, signal);
      const result = await host.githubPrAction(accountId, reference, { ...payload, action });
      signal?.throwIfAborted();
      return result;
    },
  };
}
