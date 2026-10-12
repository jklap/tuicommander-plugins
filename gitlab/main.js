import { createGitLabProvider } from './provider.js';
import { accountFetch, readConfig } from './runtime.js';

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

let active = null;

export default {
  id: 'gitlab',
  async onload(host) {
    const config = await readConfig(host, 'gitlab');
    if (!config?.accounts?.length) {
      host.log('warn', 'gitlab has no accounts: write data/config.json with {"accounts":[{"id":"<account id>","host":"https://gitlab.com","project":"group/project"}]}.');
      return;
    }
    const accounts = config.accounts.map(({ project, boards, ...account }) => ({ kind: 'bearer', ...account, provider: 'gitlab' }));
    const configuration = Object.fromEntries(config.accounts.map(({ id, project, boards }) => [id, { project, boards }]));
    active = registerGitLabAccounts(host, accounts, (id) => accountFetch(host, id), configuration);
  },
  onunload() {
    active?.dispose();
    active = null;
  },
};
