# Jira work-item provider

Data-only provider for core Tasks. No plugin HTML, token storage, or CLI dependency.
Each factory instance is bound to one core account: `{id, host, kind}`. Use `basic`
for Jira Cloud (email metadata and API token held in the core vault), or `bearer`
for Jira Data Center (PAT). The site may contain a context path and explicit port.
`verify()` calls `/rest/api/3/myself` or `/rest/api/2/myself`; the manifest login verify path is `/rest/api/2/myself` (Cloud and Data Center both serve it).

## Integration

`createJiraProvider({account, fetch, projectId})` accepts an authenticated fetch
port. The port receives `{url, method, body, headers}` and returns
`{status, headers, json}`. Authentication is injected by Rust; never pass a token
to this module. Non-browser `User-Agent` must be forwarded by the host HTTP port.
The manifest declares `net:http` and the `jira` account descriptor; requests go through
`host.httpFetch(url, {account})` (`runtime.js`), so Rust injects the credential.

Install by copying this directory to `~/Library/Application Support/com.tuic.commander/plugins/jira/`
(macOS). The host gives plugins no account list, so add the account in Settings, then write
`data/config.json` inside the plugin directory (`kind`: `basic` for Cloud, `bearer` for Data Center):

```json
{ "accounts": [{ "id": "<account id>", "host": "https://site.atlassian.net", "kind": "basic", "projectId": "10000" }] }
```

Without the file `onload` logs a warning and registers nothing. The Tasks views are not mounted
in the app shell yet, and no URL resolver is registered for Jira.
A 429 blocks further calls from this provider until `Retry-After` expires (numeric
seconds or HTTP date); it does not automatically replay writes.

Cloud uses the enhanced `/rest/api/3/search/jql` token cursor. Data Center uses
REST v2 offset pagination. Search accepts JQL, an issue key shortcut, and falls
back to quoted `text ~` search on 400 only. Presets cover assigned, reported,
and recently updated items. Invalid filter/sort identifiers are rejected.

Descriptions and comments convert ADF to Markdown; Cloud writes convert Markdown
back to ADF. The supported subset covers paragraphs, headings, lists, quotes,
code blocks, links, bold, italic, and strike. Unknown ADF containers preserve
child text where available. Media, tables, extensions, complex overlapping
marks, and rich metadata cannot round-trip through this subset. Do not use an
edit of description to preserve unsupported rich content unchanged.

Create metadata is retrieved per configured project and selected issue type.
Comment pagination is independent of issue pagination. Core detail view owns
visible-only 60-second periodic refresh, not the provider.

## Fixtures and live confirmation

`fixtures/cloud.json` is **unrecorded**, hand-authored from public Jira REST v3
shapes with synthetic values. It is a test assumption, not a production recording.
No Jira Cloud site or credential exists for this assignment. These sources guide
the shape:

- [Issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Issues, creation metadata and transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Agile board configuration](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [ADF structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [Rate limits](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)

A live recording must confirm:

1. Cloud Basic email/token and DC PAT verification through the core account port,
   context-path/port handling, and a non-browser User-Agent on the wire.
2. Enhanced JQL search pagination, key lookup and 400 fallback with real permissions.
3. Issue detail, independent comment pages, create metadata for two issue types,
   required/custom field values, creation and inline edits.
4. ADF list, nested list, code, and Markdown rendering after a create/comment write.
5. Board columns containing multiple statuses, per-issue legal transition IDs,
   rejection of stale/illegal moves, and refreshed status after a successful move.
6. 429 headers and host account budget behavior; no automatic duplicate write.
7. Multi-site account changes, unload cleanup, URL resolution and draft start-work
   routing through the core host intent.

Scrub tokens, email addresses, real user IDs and private issue content before
replacing the unrecorded fixture. Desktop plugin loading waits for the core
account fetch and provider registration integration; verify after Boss's restart.
