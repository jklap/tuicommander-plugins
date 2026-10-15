import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGitHubProvider } from "./provider.js";
import { emptyQuery } from "./query.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const projectId = "PVT_kwDNJr_NE10";
const fieldId = "project:PVT_kwDNJr_NE10:PVTSSF_lADNJr_NE13Nml4";

function setup() {
  const requests = [];
  const responses = [fixture("project")];
  const provider = createGitHubProvider({
    accountId: "test-account",
    repository: "github/roadmap",
    fetch: async (request) => {
      requests.push(request);
      assert.ok(responses.length, `Unexpected request ${request.url}`);
      return { status: 200, headers: {}, json: responses.shift() };
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
