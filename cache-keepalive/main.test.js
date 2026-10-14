/**
 * Tests for the Cache Keepalive plugin.
 *
 * Run: node --test cache-keepalive/
 *
 * The plugin is driven through a PluginHost double and node's fake timers, so
 * the 4.5-minute keepalive interval passes without waiting.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import plugin from "./main.js";

const SESSION = "sess-0123456789";
const INTERVAL_MS = 5 * 60 * 1000 - 30 * 1000;
const CHECK_MS = 30 * 1000;

function makeHost() {
  const host = {
    handlers: new Map(),
    sent: [],
    logs: [],
    inputBuffer: "",
    bufferReads: [],
    log: (level, message) => host.logs.push({ level, message }),
    registerSection() {},
    addItem() {},
    updateItem() {},
    registerDashboard() {},
    registerMarkdownProvider() {},
    onStateChange() {},
    registerStructuredEventHandler: (type, handler) => host.handlers.set(type, handler),
    setTicker() {},
    clearTicker() {},
    getRepoPathForSession: () => null,
    getClaudeProjectDir: async () => null,
    async sendAgentInputIfEmpty(sessionId, text) {
      host.bufferReads.push({ sessionId });
      const buffer = typeof host.inputBuffer === "function" ? host.inputBuffer() : host.inputBuffer;
      if (buffer !== "" || host.blockSend) return false;
      host.sent.push({ sessionId, text });
      return true;
    },
    async invoke(cmd, args) {
      if (cmd === "get_input_buffer_content") {
        host.bufferReads.push(args);
        return typeof host.inputBuffer === "function" ? host.inputBuffer() : host.inputBuffer;
      }
      return null; // read_plugin_data / write_plugin_data
    },
  };
  return host;
}

/** Load the plugin with an idle Claude session, then let the interval pass. */
async function setup(t) {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
  const host = makeHost();
  plugin.onload(host);
  t.after(() => {
    plugin.onunload();
    mock.timers.reset();
  });
  host.handlers.get("shell-state")({ agent_type: "claude", state: "idle" }, SESSION);
  return host;
}

/** Advance past the keepalive interval and let the async tick settle. */
async function elapse(ms = INTERVAL_MS + CHECK_MS) {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("an idle session with an empty composer gets the keepalive", async (t) => {
  const host = await setup(t);
  await elapse();
  assert.deepEqual(host.sent, [{ sessionId: SESSION, text: "[noop]" }]);
});

test("a pending composer draft is left untouched and no noop is sent", async (t) => {
  // catches: keepalive clears the draft with Ctrl-U via sendAgentInput
  const host = await setup(t);
  host.inputBuffer = "half-typed question";
  await elapse();
  assert.deepEqual(host.sent, []);
  assert.ok(host.bufferReads.length > 0);
  assert.ok(host.bufferReads.every((args) => args.sessionId === SESSION));
});

test("a skipped draft does not consume the keepalive budget", async (t) => {
  // catches: counters bumped before the draft check, so a typing user burns the 3 pings
  const host = await setup(t);
  host.inputBuffer = "draft";
  await elapse();
  assert.equal(host.sent.length, 0);
  host.inputBuffer = "";
  await elapse(CHECK_MS);
  assert.equal(host.sent.length, 1);
});

test("an unreadable composer is treated as a draft", async (t) => {
  // catches: a failed buffer read falls through to the destructive send
  const host = await setup(t);
  host.inputBuffer = () => {
    throw new Error("pty gone");
  };
  await elapse();
  assert.deepEqual(host.sent, []);
});

test("a session awaiting a question or permission gets no keepalive", async (t) => {
  // catches: keepalive answers an open dialog
  const host = await setup(t);
  host.handlers.get("awaiting")({ awaiting: true }, SESSION);
  await elapse();
  assert.deepEqual(host.sent, []);
  assert.deepEqual(host.bufferReads, []);
});

test("keepalive resumes once the dialog is answered", async (t) => {
  // catches: awaiting flag latched forever after a single dialog
  const host = await setup(t);
  host.handlers.get("awaiting")({ awaiting: true }, SESSION);
  await elapse();
  host.handlers.get("awaiting")({ awaiting: false }, SESSION);
  await elapse(CHECK_MS);
  assert.equal(host.sent.length, 1);
});

test("a session that turns busy while the composer is read gets no keepalive", async (t) => {
  // catches: send after await without re-checking the session state
  const host = await setup(t);
  host.inputBuffer = () => {
    host.handlers.get("shell-state")({ agent_type: "claude", state: "busy" }, SESSION);
    host.blockSend = true;
    return "";
  };
  await elapse();
  assert.deepEqual(host.sent, []);
});

test("whitespace-only draft is not cleared by a keepalive", async (t) => {
  // catches: trim treats a user's unsent spaces and multiline newline as empty
  const host = await setup(t);
  host.inputBuffer = "  \n ";
  await elapse();
  assert.deepEqual(host.sent, [], "a nonempty draft must not receive Ctrl-U or a noop");
});

test("awaiting received before the first shell state still blocks keepalive", async (t) => {
  // catches: awaiting is discarded before shell-state creates the session tracker
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
  const host = makeHost();
  plugin.onload(host);
  t.after(() => {
    plugin.onunload();
    mock.timers.reset();
  });
  // Backend snapshots dispatch awaiting independently of the shell-state stream.
  host.handlers.get("awaiting")({ awaiting: true }, SESSION);
  host.handlers.get("shell-state")({ agent_type: "claude", state: "idle" }, SESSION);
  await elapse();
  assert.deepEqual(host.sent, [], "an already open dialog must not be answered by a noop");
});
