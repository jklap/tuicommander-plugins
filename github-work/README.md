# GitHub Work provider

This data-only adapter implements the A4 WorkItemProvider interface with an injected
account-scoped fetch function. It has no iframe, credentials, independent request budget,
or PTY execution. `manifest.json` + `main.js` make it an installable plugin (`providers: ["github"]`, `net:http`).

## Install and configure

Copy this directory to `~/Library/Application Support/com.tuic.commander/plugins/github-work/`
(macOS; `docs/plugins.md` → Build & Install). Configure the provider through **Tasks setup**. Tasks stores the selected accounts in
`data/work-items.json`, separate from schema-backed plugin Settings:

```json
{ "accounts": [{ "id": "github.com", "repository": "owner/repo" }] }
```

`id` is the account id from Settings > Accounts (`github.com` for the ambient login); optional
`apiUrl` and `webOrigin` select a GitHub Enterprise host. One provider is registered per account,
so an account serves one repository. Without the file the plugin logs a warning and registers nothing.
`runtime.js` adapts `fetch({url,method,body})` onto `host.httpFetch(url,{account})`.
Core Tasks renders the provider views and setup form. The provider also serves
command-palette URL paste (link + drafted start work) and the sidebar link badge.

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
fields. Recorded public GitHub roadmap reads cover board cards and field metadata.
Tests check move and clear requests against the documented mutation contract without
sending live writes. Live mutation round trips and desktop loading remain unverified. Project queries
reject unsupported search/filter/sort instead of silently ignoring them. Board moves
use `updateProjectV2ItemFieldValue`, never issue close. Draft issues are excluded.

## Integration tasks still open

- Verify the catalog release asset and desktop installation against the published version.
- Verify B6/B7 desktop integration. Runtime registration now binds
  `host.githubReviewThreads` and `host.githubPrAction` to each selected account;
  these ports retain core policy without extending the invoke whitelist.
- Verify live board mutation and roadmap field round trips only with separate write authorization.
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
Projects scope error and successful public roadmap read are real recordings; mutation
responses in tests are documented contracts, not recordings of writes.

Projects API reference:
https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects

Task details declare the `edit_field` action for API-editable schema fields. The host enables only fields marked editable; Jira requires an explicit `set` operation and keeps project, issue type and status on their typed workflows. Save errors remain visible without discarding the draft.

Opening Tasks Board discovers the current user Projects v2 through paged `viewer.projectsV2` queries. Select a returned project in the core picker. A missing scope error names `read:project`. Discovery success tests use documented GraphQL response shapes; the insufficient-scope fixture is recorded. No live successful Projects discovery is claimed.
