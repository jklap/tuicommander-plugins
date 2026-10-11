import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createGitHubProvider } from "./provider.js";

// Oracle: live github.com search probes on 2026-10-11 (critic-1693):
//   repo:sstraus/tuicommander is:"pull" -> 0, is:pr -> 41
//   repo:microsoft/vscode milestone:"8" -> 0, milestone:"Backlog" (milestone #8) -> 17211
//   repo:microsoft/vscode label:"bug" label:"feature-request" -> 48 (AND), label:"bug","feature-request" -> 75867 (OR)
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

function harness() {
  const searches = [];
  const fetch = async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/search/issues") {
      searches.push(parsed.searchParams.get("q"));
      return { status: 200, headers: {}, json: fixture("pull-search.json") };
    }
    if (parsed.pathname.endsWith("/milestones")) {
      return { status: 200, headers: {}, json: fixture("milestones.json") };
    }
    if (parsed.pathname.endsWith("/labels")) return { status: 200, headers: {}, json: fixture("labels.json") };
    throw new Error(`Unexpected request ${url}`);
  };
  const provider = createGitHubProvider({ accountId: "acct", repository: "sstraus/tuicommander", fetch });
  return { provider, searches };
}

const query = (filters) => ({
  filters,
  savedFilterId: null,
  search: "",
  sort: null,
  groupBy: null,
  cursor: null,
  limit: 10,
});

test("critic: filtering by the pull itemType the adapter itself reports reaches GitHub as is:pr", async () => {
  // catches: itemType "pull" sent as is:"pull", which GitHub answers with zero results
  const { provider, searches } = harness();
  const [pull] = (await provider.list(query([]))).items;
  assert.equal(pull.itemType, "pull");
  await provider.list(query([{ fieldId: "itemType", values: [{ kind: "enum", value: pull.itemType }] }]));
  const q = searches.at(-1);
  assert.match(q, /(^|\s)is:"?pr"?(\s|$)/, q);
  assert.doesNotMatch(q, /is:"?pull"?/, q);
});

test("critic: a milestone filter never sends the milestone number as a title qualifier", async () => {
  // catches: milestone option/field id (the number) sent as milestone:"1", which GitHub matches by title -> zero results
  const { provider, searches } = harness();
  const milestone = (await provider.createFields("issue")).find((f) => f.id === "milestone");
  const v040 = milestone.options.find((o) => o.name === "v0.4.0");
  let rejected = false;
  try {
    await provider.list(query([{ fieldId: "milestone", values: [{ kind: "enum", value: v040.id }] }]));
  } catch {
    rejected = true;
  }
  assert.ok(!searches.some((q) => q.includes(`milestone:"${v040.id}"`)), searches.join("\n"));
  if (!rejected) assert.match(searches.at(-1), /milestone:"v0\.4\.0"/);
});

test("critic: alternative label values are ORed, not sent as two ANDed label qualifiers", async () => {
  // catches: WorkItemQuery values (ORed per docs/plugins.md) flattened into `label:"a" label:"b"`, which GitHub ANDs
  const { provider, searches } = harness();
  const labels = (name) => ({ kind: "labels", value: [{ id: name, name }] });
  try {
    await provider.list(query([{ fieldId: "labels", values: [labels("bug"), labels("area: github")] }]));
  } catch {
    // Rejecting an inexpressible query is acceptable; silently narrowing it is not.
  }
  for (const q of searches) assert.ok((q.match(/(^|\s)label:/g) ?? []).length <= 1, q);
});
