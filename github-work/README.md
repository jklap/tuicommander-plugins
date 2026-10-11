# GitHub Work provider — integration pending

This data-only adapter implements the A4 WorkItemProvider interface with an injected
account-scoped fetch function. It has no iframe, credentials, independent request budget,
or PTY execution. It is **not yet an installable plugin**.

```js
import { createGitHubProvider } from './provider.js';
const provider = createGitHubProvider({
  accountId, repository: 'owner/repo', fetch: accountScopedFetch,
  // Optional core ports; the adapter never duplicates review/merge policy.
  core: { reviewThreads, prAction },
});
const disposable = host.registerWorkItemProvider(provider);
```

`fetch({url, method, body?})` returns `{status, headers, json}`. The host must inject
account authentication and own the shared request budget. The adapter exposes HTTP
errors with status and Retry-After, makes no automatic retries, and suppresses stale
responses after abort. URL resolution checks the account web origin. Enterprise
accounts can supply `apiUrl` and `webOrigin`.

Reads include qualifier search, presets, cursor pagination, repository create metadata,
issue/PR detail, issue comments and PR review summaries. The `duplicates(title)` method
returns candidates without choosing one or writing anything. The generic Tasks create
surface still needs to call this method to show its picker.

Mutations support issue creation, editable issue fields, comments and close reasons.
Start work returns the core host intent. `runPrAction(reference, action, payload)`
delegates to the supplied B7 port; it does not implement another merge/review engine.
`core.reviewThreads(reference, cursor, limit, signal)` must return the existing B6
`{headSha, threads, hasNextPage, endCursor}` response. `prAction` remains host-owned
and must enforce the selected account, reviewed head and permissions.

Projects v2 board and roadmap access is implemented through `board(projectId, query)`
and `projectItems(projectId, query)`, including single-select, date, text and number
fields. This path is **unverified**: the available GitHub credential lacks
`read:project`, and no successful Projects fixture has been recorded. Project queries
reject unsupported search/filter/sort instead of silently ignoring them. Board moves
use `updateProjectV2ItemFieldValue`, never issue close. Draft issues are excluded.

## Integration tasks still open

- Story 1697-4cdc: wire the real `host.httpFetch({account})` response to the fetch port;
  add the runtime lifecycle/manifest and one registry entry. No unauthenticated fallback.
- Bind B6/B7 core ports and expose their actions in the Tasks surface. Current
  `host.invoke` does not whitelist them; do not bypass the host.
- Record successful Projects v2 reads with a credential that has `read:project`, then
  verify board mutation and roadmap field round trips on recorded responses.
- Connect duplicate candidates to the generic create picker.
- Integration owner: add desktop-load verification to `to-test.md`, update product
  docs, and capture Chromium/WebKit screenshots after the runtime is wired.

## Validation

Run from the TUIC checkout through `scripts/with-test-tmp.sh`:
`pnpm --dir plugins/github-work test`. This runs only this provider's tests; the root
`test:plugins` script expands the entire plugin tree and cannot select a directory.

Fixtures were recorded with read-only GitHub requests. `fixtures/provenance.json`
records each endpoint, date and filename. Email values and email addresses were
removed. No tokens, authorization headers or TUIC account IDs are committed. The
Projects scope error is a real recording, not a successful project fixture.

Projects API reference:
https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
