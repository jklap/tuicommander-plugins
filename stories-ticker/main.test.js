import assert from "node:assert/strict";
import test from "node:test";

import plugin from "./main.js";

function makeHost(names) {
  const host = {
    repoPath: "/repo",
    names,
    stateHandlers: [],
    tickers: [],
    cleared: [],
    watches: [],
    onStateChange(handler) { host.stateHandlers.push(handler); },
    getActiveRepoPath() { return host.repoPath; },
    async listDirectory() { return host.names; },
    async watchPath(path, callback) {
      const watch = { path, callback, disposed: false, dispose() { watch.disposed = true; } };
      host.watches.push(watch);
      return watch;
    },
    setTicker(ticker) { host.tickers.push(ticker); },
    clearTicker(id) { host.cleared.push(id); },
    log() {},
  };
  return host;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("counts only open Markdown stories", async (t) => {
  const host = makeHost(["a-ready-task.md", "b-complete-task.md", "c-wontfix-task.md", "d-in_progress-task.md"]);
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();

  assert.equal(host.tickers.at(-1).text, "2 open");
  assert.equal(host.tickers.at(-1).label, "Stories");
});

test("refreshes from its watch and disposes it on unload", async () => {
  const host = makeHost(["a-ready-task.md"]);
  plugin.onload(host);
  await settle();

  host.names = [];
  host.watches[0].callback();
  await settle();
  assert.equal(host.cleared.at(-1), "open-count");

  const watch = host.watches[0];
  plugin.onunload();
  assert.equal(watch.disposed, true);
});
