import { createJiraProvider } from './provider.js';
import { accountFetch, readConfig } from './runtime.js';

const slug = (title) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** Pasted issue URL → link plus a drafted start-work brief, from the first account that owns the URL. */
export function urlResolver(providers) {
  return async (url, signal) => {
    for (const provider of providers) {
      const reference = provider.resolveUrl(url);
      if (!reference) continue;
      const { item, body } = await provider.detail(reference, signal);
      return {
        link: { reference, key: item.key, title: item.title, url: item.url, state: item.state },
        startWork: {
          branch: `${item.key}-${slug(item.title) || 'issue'}`,
          prompt: `Jira issue ${item.key}: ${item.title}\n${item.url}\n\n${body}`,
          delivery: 'draft',
        },
      };
    }
    return null;
  };
}

/** Host integration seam. A3c supplies fetchForAccount; tokens never enter JS. */
export function registerJiraAccounts(host, accounts, fetchForAccount, configuration = {}) {
  const registrations = [];
  const providers = [];
  try {
    for (const account of accounts.filter((a) => a.provider === 'jira')) {
      const provider = createJiraProvider({
        account, fetch: fetchForAccount(account.id), ...(configuration[account.id] ?? {}),
      });
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
  id: 'jira',
  async onload(host) {
    const config = await readConfig(host, 'jira');
    const rawSettings = await host.invoke('read_plugin_data', { pluginId: 'jira', path: 'config.json' });
    const defaults = rawSettings ? JSON.parse(rawSettings) : {};
    if (!config?.accounts?.length) {
      host.log("warn", "jira has no accounts: configure this provider in Tasks setup.");
      return;
    }
    const accounts = config.accounts.map(({ projectId, boards, ...account }) => ({ ...account, provider: 'jira' }));
    const configuration = Object.fromEntries(config.accounts.map(({ id, projectId, boards }) => [id, { projectId: projectId || defaults.projectId || undefined, boards }]));
    active = registerJiraAccounts(host, accounts, (id) => accountFetch(host, id), configuration);
  },
  onunload() {
    active?.dispose();
    active = null;
  },
};
