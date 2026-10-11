import { createGitLabProvider } from './provider.js';

const slug = (title) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** Pasted item URL → link (and start work for an issue), from the first account that owns the URL. */
export function urlResolver(providers) {
  return async (url, signal) => {
    for (const provider of providers) {
      const reference = provider.resolveUrl(url);
      if (!reference) continue;
      const { item, body } = await provider.detail(reference, signal);
      const link = { reference, key: item.key, title: item.title, url: item.url, state: item.state };
      if (item.itemType !== 'issue') return { link };
      const iid = reference.id.split('#').pop();
      return {
        link,
        startWork: {
          branch: `${iid}-${slug(item.title) || 'issue'}`,
          prompt: `GitLab issue ${item.key}: ${item.title}\n${item.url}\n\n${body}`,
          delivery: 'draft',
        },
      };
    }
    return null;
  };
}

/**
 * Host integration seam. A3c (story 1697-4cdc) supplies `fetchForAccount`, which
 * injects the account PAT in Rust; tokens never enter JS. `configuration[accountId]`
 * may name a default `project` path and its `boards`.
 */
export function registerGitLabAccounts(host, accounts, fetchForAccount, configuration = {}) {
  const registrations = [];
  const providers = [];
  try {
    for (const account of accounts.filter((a) => a.provider === 'gitlab')) {
      const provider = createGitLabProvider({ account, fetch: fetchForAccount(account.id), ...(configuration[account.id] ?? {}) });
      registrations.push(host.registerWorkItemProvider(provider));
      providers.push(provider);
    }
    if (providers.length) registrations.push(host.registerUrlResolver(urlResolver(providers)));
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    throw error;
  }
  return { dispose() { for (const registration of registrations.splice(0).reverse()) registration.dispose(); } };
}

export default {
  id: 'gitlab',
  onload(host) {
    // Account enumeration and authenticated HTTP belong to A1/A3c. Do not invent
    // a token-bearing path while those APIs land.
    host.log('warn', 'GitLab provider requires the account HTTP integration before activation.');
  },
  onunload() {},
};
