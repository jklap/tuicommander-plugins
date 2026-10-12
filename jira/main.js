import { createJiraProvider } from './provider.js';
import { accountFetch, readConfig } from './runtime.js';

/** Host integration seam. A3c supplies fetchForAccount; tokens never enter JS. */
export function registerJiraAccounts(host, accounts, fetchForAccount, configuration = {}) {
  const registrations = [];
  try {
    for (const account of accounts.filter((a) => a.provider === 'jira')) {
      const provider = createJiraProvider({
        account, fetch: fetchForAccount(account.id), ...(configuration[account.id] ?? {}),
      });
      registrations.push(host.registerWorkItemProvider(provider));
    }
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
    if (!config?.accounts?.length) {
      host.log('warn', 'jira has no accounts: write data/config.json with {"accounts":[{"id":"<account id>","host":"https://site.atlassian.net","kind":"basic"}]}.');
      return;
    }
    const accounts = config.accounts.map(({ projectId, boards, ...account }) => ({ ...account, provider: 'jira' }));
    const configuration = Object.fromEntries(config.accounts.map(({ id, projectId, boards }) => [id, { projectId, boards }]));
    active = registerJiraAccounts(host, accounts, (id) => accountFetch(host, id), configuration);
  },
  onunload() {
    active?.dispose();
    active = null;
  },
};
