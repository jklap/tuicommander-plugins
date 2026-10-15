import { createGitHubProvider } from "./provider.js";
import { accountCore, accountFetch, readConfig } from "./runtime.js";

const ID = "github-work";
const slug = (title) =>
  title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

/** Pasted issue URL → link, plus a drafted start-work brief; null for URLs this provider does not own. */
export function urlResolver(providers) {
  return async (url, signal) => {
    for (const provider of providers) {
      let reference;
      try {
        reference = provider.resolveUrl(url);
      } catch {
        continue;
      }
      const { item, body } = await provider.detail(reference, signal);
      const link = { reference, key: item.key, title: item.title, url: item.url, state: item.state };
      if (item.itemType !== "issue") return { link };
      const number = reference.id.split("/").pop();
      return {
        link,
        startWork: {
          branch: `${number}-${slug(item.title) || "issue"}`,
          prompt: `GitHub issue ${item.key}: ${item.title}\n${item.url}\n\n${body}`,
          delivery: "draft",
        },
      };
    }
    return null;
  };
}

/** One provider per configured account entry `{id, repository, apiUrl?, webOrigin?}`; the registry keys on account id. */
export function registerGitHubAccounts(host, entries) {
  const registrations = [];
  const providers = [];
  try {
    for (const { id, repository, apiUrl, webOrigin } of entries) {
      const provider = createGitHubProvider({ accountId: id, repository, fetch: accountFetch(host, id), apiUrl, webOrigin, core: accountCore(host, id) });
      registrations.push(host.registerWorkItemProvider(provider));
      providers.push(provider);
    }
    if (providers.length) registrations.push(host.registerUrlResolver(urlResolver(providers)));
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    throw error;
  }
  return {
    dispose() {
      for (const registration of registrations.splice(0).reverse()) registration.dispose();
    },
  };
}

let active = null;

export default {
  id: ID,
  async onload(host) {
    const config = await readConfig(host, ID);
    if (!config?.accounts?.length) {
      host.log("warn", "github-work has no accounts: write data/config.json with {\"accounts\":[{\"id\":\"github.com\",\"repository\":\"owner/repo\"}]}.");
      return;
    }
    active = registerGitHubAccounts(host, config.accounts);
  },
  onunload() {
    active?.dispose();
    active = null;
  },
};
