# GitLab work-item provider

Data-only provider for core Tasks: no plugin HTML, no token storage, no `glab` CLI.
One factory instance per core account `{id, host, login, label}`, so work and
personal accounts, and several self-hosted instances, run side by side. The
account `host` is the instance identity: scheme, hostname, **port** and relative
URL root. `https://git.example:8443` and `https://git.example` are two instances;
a URL or reference of one is never resolved by the other.

## Integration

`createGitLabProvider({account, fetch, project?, boards?})` takes an authenticated
fetch port. It receives `{url, method, body?, headers}` and returns
`{status, headers, json, text?}` (`text` only for the job log). The core injects the
PAT (`Authorization: Bearer`) in Rust and owns the request budget; never pass a
token to this module. Error messages never contain the response body.

Account descriptor for the core registry: kind `bearer` (personal access token,
scope `api`, or `read_api` for read-only use), verify `GET /api/v4/user`, login
pointer `/username`.

`project` (a path such as `group/sub/project`) scopes boards, create and short
references (`!7`, `#12`). Without it, lists use the instance-wide endpoints with
`scope=all`, which on gitlab.com means every item the token can read.

The manifest declares `net:http` and the `gitlab` account descriptor; requests go through
`host.httpFetch(url, {account})` (`runtime.js`), so Rust injects the PAT.

Install by copying this directory to `~/Library/Application Support/com.tuic.commander/plugins/gitlab/`
(macOS). The host gives plugins no account list, so add the account in Settings, then write
`data/config.json` inside the plugin directory:

```json
{ "accounts": [{ "id": "<account id>", "host": "https://gitlab.com", "login": "me", "project": "group/project" }] }
```

`kind` defaults to `bearer`; `label`, `login`, `project` and `boards` are optional. Without the
file `onload` logs a warning and registers nothing. The Tasks views are not mounted in the app
shell yet: a registered provider serves the command-palette URL paste and the sidebar link badge.

## Behavior

- **List:** issues, merge requests, pending to-do items. Presets: assigned, created,
  review requests (needs the account login), to-do list. Filters: type, state,
  labels, assignee, author, updated/created after. Sort by updated or created,
  either direction. Search text, or a reference/URL that opens the item directly.
  Offset pagination from `x-next-page`; the page `total` is `x-total` (omitted for
  the to-do list). The roadmap plots `start` (milestone start) to `target` (issue due
  date, else milestone due date); both are display-only, not filters.
- **Detail:** description, discussions (system notes dropped; diff notes become
  review threads with resolved state), inline edit of title, description, labels,
  assignees and due date, close/reopen, comment, start work.
- **Merge requests:** merge or squash-and-merge (named after the project merge
  method; a choice the project's `squash_option` forbids is disabled). The merge is
  pinned to the head sha the user saw, so a later push gives 409, not an unreviewed
  merge. `detailed_merge_status` becomes a sentence on the disabled merge actions
  and in the `merge_status` field. Rebase when GitLab asks for it. Approve and
  revoke approval.
- **Pipelines:** latest MR pipeline and its jobs as a Markdown table, retry the
  pipeline or a failed job, `jobTrace(ref, jobId)` returns the log as plain text
  (ANSI and section markers removed, last 256 KiB).
- **Boards:** label lists in board order between Open and Closed. A move adds the
  target list label and removes the source one (`add_labels`/`remove_labels`);
  Closed closes, leaving Closed reopens. Assignee and milestone lists are skipped.
- **Create:** issue with title, description, labels, assignees and due date.
- **429:** `Retry-After` blocks further calls of this provider; writes are never
  replayed automatically.

Planning dates remain available to the roadmap. They set `queryable: false` so the core list does not offer unsupported date filters or grouping.

## Fixtures

`fixtures/recorded.json` holds responses **recorded from a GitLab CE container**
(version and image digest in its `_provenance` block) and scrubbed: instance origin
and hostname become `gitlab.example.invalid:8443`, avatar URLs and e-mail addresses
are replaced; no token is ever stored. Every test derives ids, paths and expected
values from it.

Recorded: `/user`, issue and MR detail, approvals, project merge settings, MR
pipelines, jobs, a job trace, MR and issue discussions (system notes, a `<details>`
note, a two-note diff thread), labels, members, a board with label lists, pending
to-dos (Issue and Commit targets), a 409 for a merge pinned to a stale `sha`, and an
issues page with `x-next-page`.

Not recorded, still written in the tests: 429 `Retry-After`, the write responses
(`{iid}` stubs), the 405/406/422 merge blockers (the tests set
`detailed_merge_status` on a recorded MR), and the assignee list of a board
(Premium only; one hand-added row in `board_move_changes_label`).

Re-record: start `gitlab/gitlab-ce`, create group `demo`, project `widgets`
(merge method `merge`, squash `default_off`), labels `bug`, `To Do`, `Doing`; issues
#1 (labels `bug`,`To Do`, assigned to root) and #2 (closed); user `dev`; MR !1 from a
branch with a `.gitlab-ci.yml` of two jobs (`build` success, `test` failed, set
through the Rails console because no runner runs; the trace comes from the real
endpoint); a diff note plus reply; a board with the two label lists; then
`GITLAB_URL=... GITLAB_TOKEN=... node fixtures/record.mjs`. The token comes from the
environment only.

## Validation

From the TUIC checkout: `scripts/with-test-tmp.sh pnpm --dir plugins/gitlab test`.

Detail field values project the recorded title, description, labels and assignees alongside the matching header metadata.

Task details declare the `edit_field` action for API-editable schema fields. The host enables only fields marked editable; Jira requires an explicit `set` operation and keeps project, issue type and status on their typed workflows. Save errors remain visible without discarding the draft.
