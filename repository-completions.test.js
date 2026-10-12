import assert from "node:assert/strict";
import test from "node:test";
import plan from "./plan/main.js";
import stories from "./stories-ticker/main.js";
import mdkb from "./mdkb-dashboard/main.js";
import rtk from "./rtk-dashboard/main.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function host() {
  const h = {
    repo: { path: "/a", displayName: "A" }, handlers: [], tickers: [], panels: [], opened: [],
    getActiveRepo() { return h.repo; }, getActiveRepoPath() { return h.repo?.path; },
    onStateChange(fn) { h.handlers.push(fn); }, registerStructuredEventHandler() {},
    registerTerminalAction() {}, registerContextMenuAction() {},
    registerDashboard(entry) { h.dashboard = entry.open; },
    async watchPath() { return { dispose() {} }; }, async listDirectory() { return []; },
    async readFile() { throw new Error("not found"); }, async execCli() { return "{}"; },
    log() {}, clearTicker() {}, setTicker(ticker) { h.tickers.push(ticker); },
    openMarkdownFileBackground(path) { h.opened.push(path); },
    openPanel(options) {
      const panel = { ...options, closed: false, updates: [], update(html) { if (panel.closed) return false; panel.updates.push(html); return true; } };
      h.panels.push(panel); return panel;
    },
    switchRepo(path) { h.repo = path ? { path, displayName: path } : null; for (const fn of h.handlers) fn({ type: "repo-changed" }); },
  };
  return h;
}

// Catches: a marker read from repository A opens a tab after the user selects B.
test("plan ignores a marker completion from the previous repository", async (t) => {
  const h = host(); const pending = deferred();
  h.readFile = (path) => path.startsWith("/a/") ? pending.promise : Promise.reject(new Error("not found"));
  plan.onload(h); t.after(() => plan.onunload());
  h.switchRepo("/b"); pending.resolve(JSON.stringify({ path: "old.md" })); await settle();
  assert.deepEqual(h.opened, []);
});

// Catches: an older scan overwrites B's current count.
test("stories keeps the current repository count when the old scan finishes last", async (t) => {
  const h = host(); const pending = deferred();
  h.listDirectory = (path) => path.startsWith("/a/") ? pending.promise : Promise.resolve(["current-ready.md"]);
  stories.onload(h); t.after(() => stories.onunload());
  h.switchRepo("/b"); await settle(); pending.resolve(["old-ready.md", "older-ready.md"]); await settle();
  assert.equal(h.tickers.at(-1).text, "1 open");
});

// Catches: MDKB has no repo-switch subscription and republishes the old repo's result.
test("mdkb refreshes its ticker on repo switch and discards the old request", async (t) => {
  const h = host(); const pending = deferred(); const queried = [];
  h.execCli = (_bin, _args, cwd) => { queried.push(cwd); return cwd === "/a" ? pending.promise : Promise.resolve("{}"); };
  mdkb.onload(h); t.after(() => mdkb.onunload()); h.switchRepo("/b"); await settle();
  pending.resolve("{}"); await settle();
  assert.deepEqual(queried, ["/a", "/b"]);
});

// Catches: an RTK fetch completing after unload dereferences hostRef or recreates a panel.
test("rtk does not open a dashboard after unload during its fetch", async () => {
  const h = host(); const pending = deferred(); h.execCli = () => pending.promise;
  await rtk.onload(h); const opening = h.dashboard(); rtk.onunload();
  pending.resolve("{}"); await opening;
  assert.deepEqual(h.panels, []);
});

// Catches: a failed scan after unload reads the now-null host in its error path.
test("stories does not write a ticker after unload during its scan", async () => {
  const h = host(); const pending = deferred(); h.listDirectory = () => pending.promise;
  stories.onload(h); stories.onunload(); pending.resolve(["old-ready.md"]); await settle();
  assert.deepEqual(h.tickers, []);
});
