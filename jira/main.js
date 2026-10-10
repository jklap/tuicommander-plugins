import { createJiraProvider } from './provider.js';

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

export default {
  id: 'jira',
  onload(host) {
    // Account enumeration + authenticated HTTP wiring belongs to A1/A3c. Do
    // not invent a token-bearing compatibility path while those APIs land.
    host.log('warn', 'Jira provider requires the account HTTP integration before activation.');
  },
  onunload() {},
};
