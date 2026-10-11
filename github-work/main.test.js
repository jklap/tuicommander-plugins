import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import plugin, { registerGitHubAccounts } from "./main.js";
import { accountFetch } from "./runtime.js";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

function fakeHost({ config = null, responses = [] } = {}) {
  const calls = [];
  const live = { providers: [], resolvers: [] };
  const track = (list, value) => {
    list.push(value);
    return { dispose: () => list.splice(list.indexOf(value), 1) };
  };
  return {
    calls,
    live,
    logs: [],
    log(level, message) {
      this.logs.push([level, message]);
    },
    invoke: async (cmd, args) => {
      assert.equal(cmd, "read_plugin_data");
      assert.deepEqual(args, { pluginId: "github-work", path: "config.json" });
      return config && JSON.stringify(config);
    },
    httpFetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      assert.ok(next, `Unexpected request ${url}`);
      return { status: 200, headers: {}, body: JSON.stringify(next) };
    },
    registerWorkItemProvider: (provider) => track(live.providers, provider),
    registerUrlResolver: (resolver) => track(live.resolvers, resolver),
  };
}

// Catches: the plugin sending the request without the account (an anonymous, rate-limited call), or a body
// that is not serialised (Rust expects a string), or no Content-Type on a write.
test("account_fetch_sends_account_and_serialised_body", async () => {
  const host = fakeHost({ responses: [{ ok: true }] });
  const response = await accountFetch(host, "github.com")({
    url: "https://api.github.com/graphql",
    method: "POST",
    body: { query: "{ viewer { login } }" },
  });
  const { url, options } = host.calls[0];
  assert.equal(url, "https://api.github.com/graphql");
  assert.equal(options.account, "github.com");
  assert.equal(options.body, '{"query":"{ viewer { login } }"}');
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.ok(options.headers["User-Agent"]);
  assert.deepEqual(response.json, { ok: true });
});

// Catches: a non-JSON body (a log, an HTML error page) throwing inside the adapter instead of reaching the client.
test("account_fetch_keeps_non_json_bodies_as_text", async () => {
  const host = { httpFetch: async () => ({ status: 502, headers: {}, body: "<html>bad gateway</html>" }) };
  const response = await accountFetch(host, "github.com")({ url: "https://api.github.com/x" });
  assert.equal(response.json, undefined);
  assert.equal(response.text, "<html>bad gateway</html>");
  assert.equal(response.status, 502);
});

// Catches: the manifest missing `providers`/`net:http`, which makes Rust refuse every account request.
test("manifest_declares_github_account_use", () => {
  assert.deepEqual(manifest.providers, ["github"]);
  assert.ok(manifest.capabilities.includes("net:http"));
  assert.equal(manifest.id, plugin.id);
});

// Catches: activation without configuration registering a provider bound to a guessed repository.
test("onload_without_config_registers_nothing_and_says_why", async () => {
  const host = fakeHost();
  await plugin.onload(host);
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
  assert.equal(host.logs[0][0], "warn");
  assert.match(host.logs[0][1], /config\.json/);
});

// Catches: provider/resolver leaked after unload, so a reload throws "already registered".
test("onload_registers_configured_accounts_and_unload_removes_them", async () => {
  const host = fakeHost({ config: { accounts: [{ id: "github.com", repository: "sstraus/tuicommander" }] } });
  await plugin.onload(host);
  assert.equal(host.live.providers.length, 1);
  assert.equal(host.live.providers[0].accountId, "github.com");
  assert.equal(host.live.resolvers.length, 1);
  plugin.onunload();
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
});

// Catches: a failure on the second account leaving the first registered.
test("failed_registration_rolls_back_earlier_accounts", () => {
  const host = fakeHost();
  assert.throws(() =>
    registerGitHubAccounts(host, [
      { id: "github.com", repository: "sstraus/tuicommander" },
      { id: "broken", repository: "not a repository" },
    ]),
  );
  assert.deepEqual(host.live, { providers: [], resolvers: [] });
});

// Catches: a pasted non-GitHub URL claimed by this plugin (palette would try to open it as an item).
test("resolver_ignores_urls_it_does_not_own", async () => {
  const host = fakeHost();
  registerGitHubAccounts(host, [{ id: "github.com", repository: "sstraus/tuicommander" }]);
  const resolve = host.live.resolvers[0];
  assert.equal(await resolve("https://example.org/a/b/issues/1", new AbortController().signal), null);
  assert.equal(await resolve("https://github.com/sstraus/tuicommander/tree/main", new AbortController().signal), null);
  assert.equal(host.calls.length, 0);
});

// Catches: pasted issue URL linking without a drafted start-work brief, or submitting it.
test("pasted_issue_url_links_and_drafts_start_work", async () => {
  const issue = fixture("issue");
  const host = fakeHost({ responses: [issue, []] });
  registerGitHubAccounts(host, [{ id: "github.com", repository: "sstraus/tuicommander" }]);
  const resolved = await host.live.resolvers[0](issue.html_url, new AbortController().signal);
  assert.equal(resolved.link.reference.accountId, "github.com");
  assert.equal(resolved.startWork.delivery, "draft");
  assert.match(resolved.startWork.branch, new RegExp(`^${issue.number}-`));
  assert.equal(host.calls[0].options.account, "github.com");
});
