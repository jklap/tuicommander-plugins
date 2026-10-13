import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { comment } from "./model.js";
import { createGitHubProvider } from "./provider.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const prRef = { providerId: "github", accountId: "test-account", id: "microsoft/vscode/pull/341276" };
const provider = (responses, core) =>
  createGitHubProvider({
    accountId: "test-account",
    repository: "microsoft/vscode",
    fetch: async () => ({ status: 200, headers: {}, ...responses.shift() }),
    core,
  });

// Catches: bot classification keyed on the `[bot]` login suffix. REST names
// Copilot's line comments `Copilot` (type Bot) with no suffix (fixture cp4).
test("rest_bot_without_suffix_is_marked_bot", async () => {
  const recorded = fixture("bot-copilot-cp4");
  const line = recorded.review_comments.find((c) => c.user.login === "Copilot");
  assert.equal(comment(line).author.bot, true);
  const page = await provider([{ json: recorded.reviews }]).comments(prRef, "reviews:1", 20);
  const bots = page.entries.map((e) => [e.value.comment.author.name, e.value.comment.author.bot]);
  assert.deepEqual(bots, [
    ["copilot-pull-request-reviewer[bot]", true],
    ["ulugbekna", false],
  ]);
});

// Catches: an outdated thread shown at its stale `originalLine` as an open thread.
test("outdated_thread_keeps_null_line_and_original_line", async () => {
  const recorded = fixture("bot-threads-cur-2833").data.repository.pullRequest.reviewThreads.nodes;
  const core = {
    reviewThreads: async () => ({ headSha: "head", threads: recorded, hasNextPage: false, endCursor: null }),
  };
  const page = await provider([], core).comments(prRef, "threads:first", 20);
  const outdated = page.entries.find((e) => e.value.path === "verifiers/v1/runtimes/deployment.py" && e.value.outdated);
  assert.ok(outdated, "outdated thread is flagged");
  assert.equal(outdated.value.line, null);
  assert.equal(outdated.value.originalLine, 148);
  const current = page.entries.find((e) => e.value.line === 734);
  assert.deepEqual([current.value.outdated, current.value.originalLine], [false, 719]);
  assert.equal(current.value.comments[0].author.bot, true);
});
