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
  const fields = await provider.createFields();
  assert.equal(fields.find((f) => f.id === "title").required, true);
  assert.ok(fields.find((f) => f.id === "labels").options.some((o) => o.id === "area: github"));
  assert.equal(fields.find((f) => f.id === "milestone").options.length, 2);
  await assert.rejects(provider.createFields("pull"), /core PR flow/);
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
