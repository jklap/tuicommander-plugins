/** Fetch port over host.httpFetch: Rust injects the account credential, the plugin never holds a token. */
export function accountFetch(host, accountId) {
  return async ({ url, method = 'GET', headers = {}, body, signal }) => {
    const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
    const response = await host.httpFetch(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      account: accountId,
      signal,
    });
    let json;
    try { json = JSON.parse(response.body); } catch { json = undefined; }
    return { status: response.status, headers: response.headers, json, text: response.body };
  };
}

/** Plugin configuration from data/work-items.json, or null when the user has not written one. */
export async function readConfig(host, pluginId) {
  const raw = await host.invoke('read_plugin_data', { pluginId, path: 'work-items.json' });
  return raw ? JSON.parse(raw) : null;
}
