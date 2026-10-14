import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGitHubProvider } from "./provider.js";
import { emptyQuery } from "./query.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const issueRef = { providerId: "github", accountId: "test-account", id: "sstraus/tuicommander/issue/125" };
const prRef = { ...issueRef, id: "sstraus/tuicommander/pull/124" };
function setup(responses, options = {}) {
  const requests = [];
  const fetch = async (request) => {
    requests.push(request);
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${request.method} ${request.url}`);
    return { status: 200, headers: {}, ...response };
  };
  return {
    provider: createGitHubProvider({
      accountId: "test-account",
      repository: "sstraus/tuicommander",
      fetch,
      ...options,
    }),
    requests,
  };
}

// Catches: label qualifiers disappear during query conversion, or pagination drops search context.
test("qualifier_query_maps_to_search_api", async () => {
  const { provider, requests } = setup([
    { json: fixture("search"), headers: { Link: '<https://api.github.com/search/issues?page=2>; rel="next"' } },
    { json: fixture("search") },
  ]);
  const query = {
    ...emptyQuery(),
    search: 'is:issue label:"bug"',
    limit: 2,
    sort: { fieldId: "updatedAt", descending: true },
  };
  const first = await provider.list(query);
  assert.equal(first.items[0].title, "[Bug] when I resize a window I can see white background");
  assert.deepEqual(first.items[0].reference, issueRef);
  assert.equal(first.nextCursor, "2");
  await provider.list({ ...query, cursor: first.nextCursor });
  const url = new URL(requests[1].url);
  assert.equal(url.searchParams.get("q"), 'repo:sstraus/tuicommander is:issue label:"bug"');
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per_page"), "2");
  assert.equal(url.searchParams.get("sort"), "updated");
});

// Catches: a /pull URL is treated as an issue with the same number.
test("pr_url_resolves_to_item", async () => {
  const { provider, requests } = setup([{ json: fixture("pull") }, { json: fixture("pull-comments") }]);
  const reference = provider.resolveUrl("https://github.com/sstraus/tuicommander/pull/124#discussion");
  assert.deepEqual(reference, prRef);
  const detail = await provider.detail(reference);
  assert.equal(detail.item.itemType, "pull");
  assert.equal(detail.item.title, "test(windows): fix Windows test failures (CI run only, do not merge)");
  assert.equal(requests[0].url, "https://api.github.com/repos/sstraus/tuicommander/pulls/124");
});

// Catches: an account switch or foreign URL leaks a request into another account.
test("foreign_account_and_host_are_rejected_before_fetch", async () => {
  const { provider, requests } = setup([]);
  await assert.rejects(provider.detail({ ...issueRef, accountId: "other" }), /another provider\/account/);
  assert.throws(() => provider.resolveUrl("https://example.org/sstraus/tuicommander/pull/124"), /outside/);
  assert.throws(() => provider.resolveUrl("https://github.com/sstraus/tuicommander/issues/0"), /not a GitHub/);
  assert.equal(requests.length, 0);
});

// Catches: API failures are rendered as empty successful lists or retry loops bypass the core budget.
test("rate_limit_preserves_retry_after_and_does_not_retry", async () => {
  const { provider, requests } = setup([
    { status: 429, headers: { "Retry-After": "37" }, json: { message: "private remote text" } },
  ]);
  await assert.rejects(
    provider.list(emptyQuery()),
    // TEST-CHANGE (#1693-a816): GitHub's own reason is now part of the message instead of a generic text.
    (error) => error.status === 429 && error.retryAfter === "37" && error.message.includes("private remote text"),
  );
  assert.equal(requests.length, 1);
});

// Catches: closing without state_reason silently loses the user choice.
test("close_not_planned_sends_reason_and_reloads_authoritative_detail", async () => {
  const { provider, requests } = setup([
    { json: fixture("issue") },
    { json: fixture("issue") },
    { json: fixture("issue-comments") },
  ]);
  const result = await provider.act(issueRef, { kind: "transition", value: "close:not_planned" });
  assert.equal(requests[0].method, "PATCH");
  assert.deepEqual(requests[0].body, { state: "closed", state_reason: "not_planned" });
  // This read-only recording is open: do not optimistically manufacture a closed state.
  assert.equal(result.value.item.state.id, "open");
});

// Catches: start-work launches a process instead of returning the host-owned intent.
test("start_work_returns_intent_without_remote_writes", async () => {
  const { provider, requests } = setup([]);
  const value = {
    repoPath: "/repo",
    branch: "fix/125",
    baseRef: null,
    prompt: "Untrusted item text",
    agentType: null,
    delivery: "draft",
  };
  assert.deepEqual(await provider.act(issueRef, { kind: "start_work", value }), { kind: "start_work", value });
  assert.equal(requests.length, 0);
  await assert.rejects(
    provider.act(issueRef, { kind: "start_work", value: { ...value, branch: "" } }),
    /Invalid start/,
  );
});

// Catches: PR reviews are flattened into normal comments and lose state/head identity.
test("comment_cursor_preserves_review_source", async () => {
  const reference = { ...prRef, id: "cli/cli/pull/14634" };
  const { provider } = setup([{ json: fixture("reviewed-comments") }, { json: fixture("reviewed-reviews") }]);
  const first = await provider.comments(reference, null, 2);
  assert.equal(first.nextCursor, "reviews:1");
  const reviews = await provider.comments(reference, first.nextCursor, 2);
  assert.equal(reviews.entries[0].kind, "review_summary");
  assert.equal(reviews.entries[0].value.state, "APPROVED");
  assert.equal(reviews.entries[0].value.comment.id, "5471465390");
  assert.ok(reviews.entries[0].value.commitId);
  assert.equal(reviews.entries[0].value.comment.createdAt, "2026-10-09T14:33:25Z");
});

// Catches: unsupported/ill-typed writes silently reach GitHub or an empty title replaces the item.
test("invalid_mutations_and_cursors_do_not_reach_fetch", async () => {
  const { provider, requests } = setup([]);
  for (const action of [
    { kind: "comment", value: " " },
    { kind: "transition", value: "merge" },
    { kind: "edit_field", value: { fieldId: "state", value: { kind: "enum", value: "closed" } } },
    { kind: "edit_field", value: { fieldId: "title", value: { kind: "text", value: " " } } },
  ])
    await assert.rejects(provider.act(issueRef, action));
  await assert.rejects(provider.list({ ...emptyQuery(), cursor: "../2" }), /cursor/);
  await assert.rejects(provider.comments(issueRef, "reviews:1", 10), /no PR reviews/);
  assert.equal(requests.length, 0);
});

// Catches: Projects GraphQL errors look like an empty board and suppress missing permission.
test("projects_scope_error_is_not_an_empty_board", async () => {
  const { provider } = setup([{ json: fixture("project-scope-error") }]);
  await assert.rejects(provider.board("project-id-owned-by-consumer", emptyQuery()), /GraphQL request failed: .*read:project/);
});

// Catches: a pending/aborted search reaches the API after its consumer is gone.
test("aborted_query_does_not_fetch", async () => {
  const { provider, requests } = setup([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.list(emptyQuery(), controller.signal), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

// Catches: create drops metadata or chooses a duplicate automatically instead of returning candidates.
test("create_preserves_metadata_and_duplicate_search_is_read_only", async () => {
  const { provider, requests } = setup([{ json: fixture("search") }, { json: fixture("issue") }]);
  const candidates = await provider.duplicates("window");
  assert.equal(candidates.items[0].key, "sstraus/tuicommander#125");
  assert.equal(requests[0].method, "GET");
  assert.equal(new URL(requests[0].url).searchParams.get("q"), 'repo:sstraus/tuicommander "window" in:title is:issue');
  const result = await provider.act(null, {
    kind: "create",
    value: {
      title: "A bug",
      body: "Details",
      itemType: "issue",
      fields: {
        labels: { kind: "labels", value: [{ id: "area: github", name: "area: github" }] },
        milestone: { kind: "enum", value: "2" },
      },
    },
  });
  assert.deepEqual(requests[1].body, { title: "A bug", body: "Details", labels: ["area: github"], milestone: 2 });
  assert.equal(result.value.item.reference.id, "sstraus/tuicommander/issue/125");
  // TEST-CHANGE (#1693-a816): create no longer reloads detail after the write (2 requests, not 4).
  assert.equal(requests.length, 2);
});

// Catches: a failing read after a successful POST surfaces as a failed create, so a retry duplicates the issue.
test("create_result_comes_from_the_post_response", async () => {
  const { provider, requests } = setup([{ json: fixture("issue"), status: 201 }]);
  const result = await provider.act(null, { kind: "create", value: { title: "A bug", body: "", itemType: "issue", fields: {} } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/repos/sstraus/tuicommander/issues");
  assert.equal(requests[0].method, "POST");
  assert.equal(result.value.item.key, "sstraus/tuicommander#125");
  assert.deepEqual(result.value.comments, { entries: [], nextCursor: null });
  assert.ok(result.value.actions.some((a) => a.id === "close:completed"));
});

// Catches: GitHub's 422/403 reason is dropped, leaving the user a generic failure.
test("error_message_carries_the_github_reason", async () => {
  const { provider } = setup([{ status: 422, json: { message: "Validation Failed", errors: [{ message: "title is too long" }] } }]);
  await assert.rejects(provider.list(emptyQuery()), (e) => e.status === 422 && /Validation Failed/.test(e.message));
  const second = setup([{ status: 422, json: { errors: [{ message: "title is too long" }] } }]);
  await assert.rejects(second.provider.list(emptyQuery()), /title is too long/);
});

// Catches: a merged PR is listed as Closed because merged_at lives under pull_request in search results.
test("merged_pull_request_in_search_is_listed_as_merged", async () => {
  const { provider } = setup([{ json: fixture("pull-search") }]);
  const [pull] = (await provider.list(emptyQuery())).items;
  assert.equal(pull.state.name, "Merged");
});

// Catches: Projects collapses MERGED into a plain closed item.
test("merged_pull_request_in_project_keeps_merged_state", async () => {
  const content = {
    number: 124, title: "t", url: "https://github.com/sstraus/tuicommander/pull/124", state: "MERGED",
    updatedAt: "2026-10-05T17:31:56Z", repository: { nameWithOwner: "sstraus/tuicommander" },
    assignees: { nodes: [] }, labels: { nodes: [] },
  };
  const project = {
    id: "p", title: "P", fields: { nodes: [] },
    items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "i", content, fieldValues: { nodes: [] } }] },
  };
  const { provider } = setup([{ json: { data: { node: project } } }]);
  const page = await provider.projectItems("p", emptyQuery());
  assert.equal(page.items[0].state.name, "Merged");
});

// Catches: create fields show no live labels/milestones, or allow direct PR creation.
test("create_fields_use_recorded_repository_metadata", async () => {
  const { provider } = setup([{ json: fixture("labels") }, { json: fixture("milestones") }]);
  const fields = await provider.createFields("issue");
  assert.deepEqual(fields.map((f) => f.id), ["labels", "milestone", "assignees"]);
  assert.ok(fields.find((f) => f.id === "labels").options.some((o) => o.id === "area: github"));
  assert.equal(fields.find((f) => f.id === "milestone").options.length, 2);
  await assert.rejects(provider.createFields("pull"), /core PR flow/);
});

// Catches: createFields undefined returns an issue schema, so core Tasks finds no itemType picker and Create stays disabled.
test("create_fields_without_type_declare_an_item_type_picker_with_issue", async () => {
  const { provider, requests } = setup([]);
  const fields = await provider.createFields(undefined);
  const picker = fields.find((f) => f.id === "itemType");
  assert.equal(picker.kind, "enum");
  assert.deepEqual(picker.options.map((o) => o.id), ["issue"]);
  assert.equal(requests.length, 0);
});

// Catches: normal comments lose author, timestamp, pagination or their markdown body.
test("normal_comments_preserve_recorded_content_and_cursor", async () => {
  const { provider } = setup([
    {
      json: fixture("normal-comments"),
      headers: { link: '<https://api.github.com/repos/cli/cli/issues/14618/comments?page=2>; rel="next"' },
    },
  ]);
  const result = await provider.comments({ ...issueRef, id: "cli/cli/issue/14618" }, null, 2);
  assert.equal(result.entries[0].kind, "normal");
  assert.equal(result.entries[0].value.id, "6037249544");
  assert.equal(result.entries[0].value.author.name, "cli-triage[bot]");
  assert.equal(result.entries[0].value.createdAt, "2026-10-07T11:47:31Z");
  assert.ok(result.entries[0].value.body.length > 0);
  assert.equal(result.nextCursor, "normal:2");
});

// Catches: the host offers a query option that this provider rejects (or omits all declarations).
test('declared_query_capabilities_never_offer_rejected_options', async () => {
  const { provider } = setup(Array.from({ length: 50 }, () => ({ json: fixture("search") })));
  const base = { filters: [], savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 20 };
  assert.ok(provider.fields.some((f) => f.sortable), 'must expose a supported sort');
  assert.ok(provider.fields.some((f) => f.groupable), 'must expose a supported group');
  assert.ok(provider.fields.some((f) => f.filterable), 'must expose a supported filter');
  for (const field of provider.fields) {
    for (const capability of ['sortable', 'groupable', 'filterable']) assert.equal(typeof field[capability], 'boolean');
    if (field.sortable) await provider.list({ ...base, sort: { fieldId: field.id, descending: false } });
    if (field.groupable) await provider.grouped({ ...base, groupBy: field.id });
    if (field.filterable) {
      const option = field.options[0] ?? { id: 'demo', name: 'demo' };
      const value = field.kind === 'user' ? [{ ...option, avatarUrl: null }] : field.kind === 'labels' ? [option] : field.kind === 'date' ? '2026-10-01' : option.id;
      await provider.list({ ...base, filters: [{ fieldId: field.id, values: [{ kind: field.kind, value }] }] });
    }
  }
});

// Catches: total_count discarded, preventing the host from recognizing a complete small scope.
test("list_preserves_recorded_search_total", async () => {
 const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"));
 const provider = createGitHubProvider({ accountId: "a", repository: "demo/widgets", fetch: async () => ({ status: 200, headers: {}, json: fixture }) });
 const result = await provider.list({ filters: [], search: "", savedFilterId: null, sort: null, groupBy: null, cursor: null, limit: 100 });
 assert.equal(result.total, fixture.total_count);
});

// Catches: editable fields never become available because detail omits edit_field.
test("detail_declares_edit_field_for_supported_issue_and_pull_fields", async () => {
 for (const [ref, name, comments] of [[issueRef, "issue", "issue-comments"], [prRef, "pull", "pull-comments"]]) {
  const { provider } = setup([{ json: fixture(name) }, { json: fixture(comments) }]);
  const detail = await provider.detail(ref);
  assert.ok(detail.fields.some((f) => f.editable));
  assert.ok(detail.actions.some((a) => a.kind === "edit_field" && a.enabled));
  assert.equal(detail.fields.find((f) => f.id === "state").editable, false);
 }
});

// Documented GitHub GraphQL ProjectsV2Connection shape; success is not a live account recording.
// Catches: only the first Projects page is offered, or duplicate IDs appear twice.
test("project_discovery_pages_and_preserves_board_identities", async () => {
 const { provider, requests } = setup([
  { json: { data: { viewer: { projectsV2: { nodes: [{ id: "P1", title: "Sprint" }], pageInfo: { hasNextPage: true, endCursor: "next" } } } } } },
  { json: { data: { viewer: { projectsV2: { nodes: [{ id: "P1", title: "Sprint" }, { id: "P2", title: "Backlog" }], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
 ]);
 const boards = await provider.listBoards();
 assert.deepEqual(boards.map((b) => [b.id, b.name]), [["P1", "Sprint"], ["P2", "Backlog"]]);
 assert.equal(requests[1].body.variables.after, "next");
 assert.ok(requests.every((r) => r.body.query.startsWith("query ")));
});
// Catches: the recorded insufficient-scope error is replaced by a generic board failure.
test("project_discovery_names_missing_read_project_scope", async () => {
 const { provider } = setup([{ json: fixture("project-scope-error") }]);
 await assert.rejects(provider.listBoards(), /read:project/);
});

// Catches: local Created/Comments controls operate on missing values although REST supplied both.
test("search_rows_retain_declared_created_and_comment_fields_for_local_queries", async () => {
 const payload = fixture("search");
 const { provider } = setup([{ json: payload }]);
 const page = await provider.list(emptyQuery());
 assert.deepEqual(page.items[0].fields.createdAt, { kind: "date", value: payload.items[0].created_at });
 assert.deepEqual(page.items[0].fields.comments, { kind: "number", value: payload.items[0].comments });
});
