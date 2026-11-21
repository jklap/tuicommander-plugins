import assert from "node:assert/strict";
import test from "node:test";
import plugin from "./main.js";

function makeHost(count = 7) {
  const host = {
    repoPath: "/repo", count, stateHandlers: [], tickers: [], cleared: [], watches: [], reads: [], logs: [],
    onStateChange(handler) { host.stateHandlers.push(handler); },
    getActiveRepoPath() { return host.repoPath; },
    async getStoryCount(repoPath) {
      host.reads.push(repoPath);
      return { project: repoPath, backend: "external:wiz-stories", generation: "approved", openCount: host.count };
    },
    async watchStoryCount(repoPath, callback) {
      const watch = { repoPath, callback, disposed: false, dispose() { watch.disposed = true; } };
      host.watches.push(watch);
      return watch;
    },
    setTicker(ticker) { host.tickers.push(ticker); },
    clearTicker(id) { host.cleared.push(id); },
    log(...args) { host.logs.push(args); },
  };
  return host;
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

// Catches: retaining a filename scan or counting a different backend/scope.
test("renders the core selected-backend count without filesystem access", async (t) => {
  const host = makeHost(7);
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();
  assert.deepEqual(host.reads, ["/repo"]);
  assert.equal(host.tickers.at(-1).text, "7 open");
  assert.equal(host.tickers.at(-1).label, "Stories");
});

// Catches: native/selection invalidations failing to refresh or dispose.
test("refreshes from core invalidations and disposes on unload", async () => {
  const host = makeHost(7);
  plugin.onload(host);
  await settle();
  host.count = 0;
  host.watches[0].callback();
  await settle();
  assert.equal(host.reads.length, 2);
  assert.equal(host.cleared.at(-1), "open-count");
  plugin.onunload();
  assert.equal(host.watches[0].disposed, true);
});

// Catches: failed connector reads leaving a stale or native-fallback count.
test("clears the previous count on backend failure", async () => {
  const host = makeHost(7);
  plugin.onload(host);
  await settle();
  host.getStoryCount = async () => { throw new Error("story backend unavailable"); };
  host.watches[0].callback();
  await settle();
  assert.equal(host.cleared.at(-1), "open-count");
  assert.equal(host.tickers.length, 1);
  assert.equal(host.logs.length, 1);
  assert.match(host.logs[0][2], /story backend unavailable/);
  plugin.onunload();
});

// Catches: an old repository read overwriting the current repository's ticker.
test("ignores a late read after switching repositories", async () => {
  const host = makeHost();
  let finishOld;
  host.getStoryCount = (repoPath) => repoPath === "/repo"
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ openCount: 1 });
  plugin.onload(host);
  await settle();
  host.repoPath = "/other";
  host.stateHandlers[0]({ type: "repo-changed" });
  await settle();
  assert.equal(host.tickers.at(-1).text, "1 open");
  const published = host.tickers.length;
  finishOld({ openCount: 99 });
  await settle();
  assert.equal(host.tickers.length, published);
  assert.equal(host.watches[0].disposed, true);
  plugin.onunload();
});

// Catches: a pending snapshot publishing after unload.
test("ignores a pending read after unload", async () => {
  const host = makeHost();
  let finish;
  host.getStoryCount = () => new Promise((resolve) => { finish = resolve; });
  plugin.onload(host);
  await settle();
  plugin.onunload();
  finish({ openCount: 7 });
  await settle();
  assert.equal(host.tickers.length, 0);
  assert.equal(host.watches[0].disposed, true);
});

// Catches: a late subscription surviving unload or starting a new read.
test("disposes a watch that finishes registration after unload", async () => {
  const host = makeHost();
  let finish;
  let disposed = false;
  host.watchStoryCount = () => new Promise((resolve) => { finish = resolve; });
  plugin.onload(host);
  plugin.onunload();
  finish({ dispose() { disposed = true; } });
  await settle();
  assert.equal(disposed, true);
  assert.equal(host.reads.length, 0);
});
