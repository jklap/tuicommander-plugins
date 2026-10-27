# Jira work-item provider

Data-only provider for core Tasks. No plugin HTML, token storage, or CLI dependency.
Each factory instance is bound to one core account: `{id, host, kind}`. Use `basic`
for Jira Cloud (email metadata and API token held in the core vault), or `bearer`
for Jira Data Center (PAT). The site may contain a context path and explicit port.
`verify()` calls `/rest/api/3/myself` or `/rest/api/2/myself`; the manifest login verify path is `/rest/api/2/myself` (Cloud and Data Center both serve it).

## Integration

`createJiraProvider({account, fetch, projectId})` accepts an authenticated fetch
port. The port receives `{url, method, body, headers, signal}` and returns
`{status, headers, json}`. Authentication is injected by Rust; never pass a token
to this module. Non-browser `User-Agent` must be forwarded by the host HTTP port.
The manifest declares `net:http` and the `jira` account descriptor; requests go through
`host.httpFetch(url, {account})` (`runtime.js`), so Rust injects the credential.

Install by copying this directory to `~/Library/Application Support/com.tuic.commander/plugins/jira/`
(macOS). Add the credential account in Settings > Accounts, then configure the provider through
**Tasks setup**. Tasks stores the selected accounts in `data/work-items.json` (`kind`: `basic` for Cloud, `bearer` for Data Center):

```json
{ "accounts": [{ "id": "<account id>", "host": "https://site.atlassian.net", "kind": "basic", "projectId": "10000" }] }
```

Without the file `onload` logs a warning and registers nothing. Core Tasks renders the
provider views. The plugin registers a URL resolver for configured Jira accounts;
pasting an owned issue URL offers a link and a drafted start-work brief. Unload
removes both provider and URL-resolver registrations.

Settings > Plugins > Jira exposes an optional **Default project ID** in the
schema-backed `data/config.json`. A project selected for an account in Tasks setup
takes precedence. Keep account configuration in `data/work-items.json`; do not
move it into the settings file.
A 429 blocks further calls from this provider until `Retry-After` expires (numeric
seconds or HTTP date); it does not automatically replay writes.

Cloud uses the enhanced `/rest/api/3/search/jql` token cursor. Data Center uses
REST v2 offset pagination. Search accepts JQL and an issue key shortcut. Use
`jql: project = AITR` to require JQL, or `text: project =` for literal text.
Without a prefix, predicates with JQL operators keep their parse errors; other
input can fall back to quoted `text ~` search on 400. Lists and boards use the
same rule. A rejected JQL query shows Jira's parse message and a correction hint;
the Tasks search input keeps the typed query. Presets cover assigned, reported,
and recently updated items. Invalid filter/sort identifiers are rejected.

Descriptions and comments convert ADF to Markdown; Cloud writes convert Markdown
back to ADF. The supported subset covers paragraphs, headings, lists, quotes,
code blocks, links, bold, italic, and strike. Unknown ADF containers preserve
child text where available. Media, tables, extensions, complex overlapping
marks, and rich metadata cannot round-trip through this subset. Do not use an
edit of description to preserve unsupported rich content unchanged.

All work-item request methods accept the optional caller `AbortSignal` and pass
it to every fetch, including fallback searches, metadata pages, board transitions,
action writes and detail refreshes. Cancellation does not undo a write that Jira
has already accepted; read the item before retrying an interrupted write.

Create metadata is retrieved per configured project and selected issue type.
Comment pagination is independent of issue pagination. Core detail view owns
visible-only 60-second periodic refresh, not the provider.

## Fixtures and live confirmation

`fixtures/cloud.json` is **unrecorded**, hand-authored from public Jira REST v3
shapes with synthetic values. It is a test assumption, not a production recording.
Other files contain scrubbed Jira Cloud recordings; see `fixtures/README.md`
for their provenance and limits. These sources guide the synthetic fixture:

- [Issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Issues, creation metadata and transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Agile board configuration](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [ADF structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [Rate limits](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)

A live recording must confirm:

1. Cloud Basic email/token and DC PAT verification through the core account port,
   context-path/port handling, and a non-browser User-Agent on the wire.
2. Enhanced JQL search pagination, key lookup and plain-text fallback with real permissions.
3. Issue detail, independent comment pages, create metadata for two issue types,
   required/custom field values, creation and inline edits.
4. ADF list, nested list, code, and Markdown rendering after a create/comment write.
5. Board columns containing multiple statuses, per-issue legal transition IDs,
   rejection of stale/illegal moves, and refreshed status after a successful move.
6. 429 headers and host account budget behavior; no automatic duplicate write.
7. Multi-site account changes, unload cleanup, URL resolution and draft start-work
   routing through the core host intent.

Scrub tokens, email addresses, real user IDs and private issue content before
adding recorded fixtures. The account HTTP and provider registration ports are
already wired. Authenticated loading and the missing live boundaries still need
operator verification; a fixture test does not prove them. A browser connected to
a headless backend does not load user plugins through the normal app loader.

Detail values include Summary, Description, Assignee and Labels. Issue type uses its human name; priority and type field values retain request IDs, resolved through schema option labels by the core detail view.

Create metadata omits Project and Issue Type because `projectId` and the selected
type supply those values. `lookupUsers(fieldId, query)` uses project-scoped
assignable-user search for Assignee and user search for Reporter, returning Cloud
account IDs or Data Center usernames. Assignee lookup without a configured project
fails with `Jira project is required` before a request is sent; Reporter lookup
does not require a project. User search is read-only and bounded to 50
results; refine the query if the desired user is absent. The core create form
accepts free labels and reports missing required values beside their controls.
Parent issue keys are encoded as Jira `{key}` objects during creation.

`fixtures/malformed-jql-live.json` is a scrubbed Jira Cloud recording from
2026-10-13. It records the 400 for `(project =) ORDER BY updated DESC` using
read-only enhanced search. It contains no credentials or user identities.
The DC error test reuses its shape as an assumption, not a live DC recording.

Task details declare the `edit_field` action for API-editable schema fields. The host enables only fields marked editable; Jira requires an explicit `set` operation and keeps project, issue type and status on their typed workflows. Save errors remain visible without discarding the draft.
