import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGitHubProvider } from "./provider.js";
import { GitHubError } from "./client.js";
import { emptyQuery } from "./query.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const projectId = "PVT_kwDNJr_NE10";
const fieldId = "project:PVT_kwDNJr_NE10:PVTSSF_lADNJr_NE13Nml4";

function setup(headers = {}) {
  const requests = [];
  const responses = [fixture("project")];
  const provider = createGitHubProvider({
    accountId: "test-account",
    repository: "github/roadmap",
    fetch: async (request) => {
      requests.push(request);
      assert.ok(responses.length, `Unexpected request ${request.url}`);
      return { status: 200, headers, json: responses.shift() };
    },
  });
  return { provider, requests, responses };
}

// Catches: moving a card sends an issue-close PATCH instead of a Projects field mutation.
test("projects_v2_move_changes_field", async () => {
  const { provider, requests, responses } = setup();
  const board = await provider.board(projectId, emptyQuery());
  const card = board.lanes.find((lane) => lane.columnId === "0b6e37be").cards[0];
  assert.equal(card.item.reference.id, "github/roadmap/issue/1093");
  assert.equal(card.item.state.id, "open");
  const move = card.moves.find((move) => move.columnId === "7bdf8bc2");
  // Documented mutation response contract, not a live GitHub write recording.
  responses.push(
    { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_lADNJr_NE13OBakjpw" } } } },
    fixture("project-issue"),
    [],
  );
  const result = await provider.act(card.item.reference, move.action);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].url, "https://api.github.com/graphql");
  assert.equal(requests[1].method, "POST");
  assert.match(requests[1].body.query, /updateProjectV2ItemFieldValue/);
  assert.deepEqual(requests[1].body.variables.input, {
    projectId,
    itemId: "PVTI_lADNJr_NE13OBakjpw",
    fieldId: "PVTSSF_lADNJr_NE13Nml4",
    value: { singleSelectOptionId: "7bdf8bc2" },
  });
  assert.deepEqual(requests.slice(2).map((request) => request.method), ["GET", "GET"]);
  assert.equal(result.value.item.state.id, "open");
});

// Catches: moving to No status writes an empty option instead of clearing the project field.
test("projects_v2_no_status_clears_field", async () => {
  const { provider, requests, responses } = setup();
  const board = await provider.board(projectId, emptyQuery());
  const card = board.lanes.find((lane) => lane.columnId === "0b6e37be").cards[0];
  responses.push(
    { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_lADNJr_NE13OBakjpw" } } } },
    fixture("project-issue"),
    [],
  );
  await provider.act(card.item.reference, card.moves.find((move) => move.columnId === "").action);
  assert.match(requests[1].body.query, /clearProjectV2ItemFieldValue/);
  assert.deepEqual(requests[1].body.variables.input, {
    projectId,
    itemId: "PVTI_lADNJr_NE13OBakjpw",
    fieldId: "PVTSSF_lADNJr_NE13Nml4",
  });
});

// Catches: an arbitrary option or nonmember identity reaches the remote mutation endpoint.
test("projects_v2_rejects_unknown_option_and_nonmember_before_write", async () => {
  const { provider, requests } = setup();
  const board = await provider.board(projectId, emptyQuery());
  const card = board.lanes.find((lane) => lane.columnId === "0b6e37be").cards[0];
  await assert.rejects(
    provider.act(card.item.reference, { kind: "edit_field", value: { fieldId, value: { kind: "enum", value: "unknown" } } }),
    /Unknown project option/,
  );
  await assert.rejects(
    provider.act({ ...card.item.reference, id: "github/roadmap/issue/1" }, card.moves[0].action),
    /not a loaded member/,
  );
  assert.equal(requests.length, 1);
});

// Catches: read:project offers failing moves or disables unrelated issue actions.
test("projects_read_scope_disables_only_project_writes", async () => {
  const { provider, requests, responses } = setup({ "X-OAuth-Scopes": "repo, read:project" });
  const board = await provider.board(projectId, emptyQuery());
  const card = board.lanes.find((lane) => lane.columnId === "0b6e37be").cards[0];
  assert.match(board.board.writeDisabledReason, /project.*scope.*[Ll]og in again/);
  assert.deepEqual(card.moves, []);
  assert.equal(provider.fields.find((f) => f.id === fieldId).editable, false);
  assert.equal(provider.fields.find((f) => f.id === "title").editable, true);
  await assert.rejects(provider.act(card.item.reference, {
    kind: "edit_field", value: { fieldId, value: { kind: "enum", value: "7bdf8bc2" } },
  }), /project.*scope.*[Ll]og in again/);
  await assert.rejects(provider.act(card.item.reference, {
    kind: "edit_field", value: { fieldId, value: null },
  }), /project.*scope.*[Ll]og in again/);
  assert.equal(requests.length, 1);
  responses.push(fixture("project-issue"), []);
  const detail = await provider.detail(card.item.reference);
  assert.ok(detail.actions.filter((a) => ["comment", "transition", "edit_field"].includes(a.kind)).every((a) => a.enabled));
  responses.push({ id: 1 }, fixture("project-issue"), []);
  await provider.act(card.item.reference, { kind: "comment", value: "Repository comment remains available" });
  assert.equal(requests[3].method, "POST");
  assert.match(requests[3].url, /issues\/1093\/comments$/);
});

// Catches: project write consent is incorrectly treated as read-only.
test("projects_write_scope_retains_moves_and_editable_fields", async () => {
  const { provider } = setup({ "x-oauth-scopes": "repo, project" });
  const board = await provider.board(projectId, emptyQuery());
  assert.equal(board.board.writeDisabledReason, null);
  assert.ok(board.lanes.flatMap((lane) => lane.cards).every((card) => card.moves.length > 0));
  assert.ok(provider.fields.filter((f) => f.id.startsWith("project:")).every((f) => f.editable));
});

// Catches: an organization/project rejection poisons repository comments or unrelated projects.
test("project_write_denial_stays_local_to_that_project", async () => {
  const requests = [];
  let denied = false;
  const provider = createGitHubProvider({
    accountId: "test-account", repository: "github/roadmap",
    fetch: async (request) => {
      requests.push(request);
      // Internal port error classification, not a recorded organization response.
      if (request.body?.query?.startsWith("mutation")) {
        denied = true;
        throw new GitHubError(200, null, "Project write forbidden", ["FORBIDDEN"]);
      }
      if (request.body?.query) return { status: 200, headers: {}, json: fixture("project") };
      return { status: 200, headers: {}, json: request.url.includes("comments") ? [] : fixture("project-issue") };
    },
  });
  const board = await provider.board(projectId, emptyQuery());
  const card = board.lanes.flatMap((lane) => lane.cards)[0];
  await assert.rejects(provider.act(card.item.reference, card.moves[0].action), /Grant project write and organization access/);
  assert.equal(denied, true);
  const readonly = await provider.board(projectId, emptyQuery());
  assert.match(readonly.board.writeDisabledReason, /Grant project write/);
  assert.ok(readonly.lanes.flatMap((lane) => lane.cards).every((card) => card.moves.length === 0));
  // A denial for one project must not remove another project's moves.
  const other = await provider.board("another-project", emptyQuery());
  assert.equal(other.board.writeDisabledReason, null);
  assert.ok(other.lanes.flatMap((lane) => lane.cards).every((card) => card.moves.length > 0));
  await provider.act(card.item.reference, { kind: "comment", value: "Still available" });
  assert.ok(requests.some((request) => request.method === "POST" && request.url.endsWith("/comments")));
});
