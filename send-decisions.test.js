import assert from "node:assert/strict";
import test, { mock } from "node:test";
import retry from "./at-capacity-retry/main.js";
import wake from "./claude-wakeup/main.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function host(pending) {
  const h = {
    events: new Map(), states: [], watchers: [], sent: [], reads: 0,
    registerOutputWatcher(watcher) { h.watchers.push(watcher); },
    registerStructuredEventHandler(type, fn) { h.events.set(type, fn); },
    onStateChange(fn) { h.states.push(fn); }, registerSection() {}, registerMarkdownProvider() {}, registerDashboard() {},
    addItem() {}, updateItem() {}, removeItem() {}, setTicker() {}, clearTicker() {}, log() {},
    async playNotificationSound() {}, async sendAgentInput(id, text) { h.sent.push({ id, text }); },
    async invoke(cmd) {
      if (cmd === "get_input_buffer_content") { h.reads++; return pending.promise; }
      return null;
    },
    emit(type, payload = {}) { h.events.get(type)?.(payload, "session"); },
    state(type) { for (const fn of h.states) fn({ type, sessionId: "session" }); },
  };
  return h;
}
for (const [name, plugin] of [["retry", retry], ["wake", wake]]) {
  for (const change of ["busy", "input", "awaiting", "close", "unload", "stable"]) {
    // Catches: a queued composer read submits after the triggering state is obsolete.
    test(`${name} revalidates ${change} while the composer read is pending`, async (t) => {
      mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100000 });
      const pending = deferred(); const h = host(pending);
      plugin.onload(h); await settle();
      t.after(() => { plugin.onunload(); mock.timers.reset(); });
      if (name === "retry") {
        for (const watcher of h.watchers) {
          const match = "Selected model is at capacity".match(watcher.pattern);
          if (match) watcher.onMatch(match, "session");
        }
        mock.timers.tick(60000);
      } else {
        h.state("agent-started"); h.emit("shell-state", { state: "idle" });
        for (let i = 0; i < 4; i++) { mock.timers.tick(5000); await settle(); }
      }
      await settle(); assert.equal(h.reads, 1, "eligible session reached composer inspection");
      if (change === "busy") h.emit("shell-state", { state: "busy" });
      if (change === "input") h.emit("user-input", { content: "human command" });
      if (change === "awaiting") h.emit("awaiting", { awaiting: true });
      if (change === "close") h.emit("session-closed");
      if (change === "unload") plugin.onunload();
      pending.resolve(""); await settle();
      assert.equal(h.sent.length, change === "stable" ? 1 : 0);
    });
  }
}

// Catches: a rejected composer read after a state notification leaves an unsent
// wake pending, suppressing subsequent eligible wakeups until timeout.
test("wake releases an unsent decision after a changed-state composer read rejects", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100000 });
  const pending = deferred(); const h = host(pending);
  wake.onload(h); await settle();
  t.after(() => { wake.onunload(); mock.timers.reset(); });
  h.state("agent-started"); h.emit("shell-state", { state: "idle" });
  for (let i = 0; i < 4; i++) { mock.timers.tick(5000); await settle(); }
  assert.equal(h.reads, 1, "eligible session reached composer inspection");
  h.emit("awaiting", { awaiting: true });
  pending.reject(new Error("temporary composer unavailable")); await settle();
  const invoke = h.invoke;
  h.invoke = async (cmd, ...args) => cmd === "get_input_buffer_content" ? "" : invoke(cmd, ...args);
  h.emit("awaiting", { awaiting: false });
  mock.timers.tick(5000); await settle();
  assert.equal(h.sent.length, 1, "failed inspection must not leave an unsent wake pending");
});
