/**
 * Tests for the Wiz Kanban plugin.
 *
 * Run: node --test wiz-kanban/
 *
 * The plugin is driven through the same surface the app gives it: a PluginHost
 * double that records the calls, plus the panel handle the host hands back from
 * openPanel(). Both properties under test are about work the plugin must NOT
 * do — rebuild a board nobody is looking at, and read story files one IPC at a
 * time — so the assertions count calls rather than inspect markup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import plugin from "./main.js";

const REPO = "/repo";

/** Frontmatter the loaders accept, one story per file. */
function storyFile(seq) {
  return `---\nid: ${seq}-aaaa\ntitle: Story ${seq}\nstatus: ready\npriority: P2\n---\n\n## Work Log\n`;
}

/**
 * Minimal PluginHost double.
 *
 * `readFiles` is deliberately present: the batch read is the host API the
 * plugin is expected to use, and a double that only offered `readFile` would
 * make the N-IPC test unfalsifiable.
 */
function makeHost(fileCount) {
  const files = Array.from({ length: fileCount }, (_, i) => `${i + 1}-aaaa-ready-P2-story.md`);
  const host = {
    files,
    actions: [],
    panels: [],
    watchers: [],
    stateHandlers: [],
    readFileCalls: [],
    readFilesCalls: [],

    log() {},
    registerTerminalAction(action) {
      host.actions.push(action);
    },
    onStateChange(handler) {
      host.stateHandlers.push(handler);
    },
    /** Drive the same state event the app emits when the user switches repo. */
    emitState(event) {
      for (const handler of host.stateHandlers) handler(event);
    },
    getActiveRepo() {
      return { path: REPO, name: "repo" };
    },
    async listDirectory() {
      return files;
    },
    async readFile(path) {
      host.readFileCalls.push(path);
      return storyFile(1);
    },
    async readFiles(paths) {
      host.readFilesCalls.push(paths);
      // Derive the content from the path, not the index: a chunked read must
      // still hand every file its own body.
      return paths.map((path) => storyFile(Number.parseInt(path.split("/").pop(), 10)));
    },
    openPanel(options) {
      const existing = host.panels[0];
      if (existing) {
        // The host reuses a panel with the same id and brings it to the front.
        existing.options = options;
        existing.reopened = (existing.reopened ?? 0) + 1;
        existing.visible = true;
        return existing;
      }
      const panel = {
        options,
        updates: [],
        reopened: 0,
        visible: true,
        closed: false,
        update(html) {
          // A closed tab reports itself dead instead of swallowing the write.
          if (panel.closed) return false;
          panel.updates.push(html);
          return true;
        },
        isVisible() {
          // A closed panel is not visible — the registry drops its state.
          return panel.visible && !panel.closed;
        },
        send() {},
        close() {},
        /** Close the tab from the tab bar, behind the plugin's back. */
        closeFromTabBar() {
          panel.closed = true;
          options.onClose?.();
        },
        /** Flip visibility the way PluginPanel does when the tab is switched. */
        setVisible(visible) {
          if (panel.visible === visible) return;
          panel.visible = visible;
          options.onVisibilityChange?.(visible);
        },
      };
      host.panels.push(panel);
      return panel;
    },
    async watchPath(path, callback) {
      const watcher = { path, callback, disposed: false };
      host.watchers.push(watcher);
      return {
        dispose() {
          watcher.disposed = true;
        },
      };
    },
  };
  return host;
}

/** Let every pending promise chain settle without waiting on real timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Open the board through the terminal action the plugin registers. */
async function openBoard(host) {
  plugin.onload(host);
  await host.actions.find((a) => a.id === "open-kanban").action();
  return host.panels[0];
}

test("reads every story file in one batch call", async (t) => {
  const host = makeHost(25);
  t.after(() => plugin.onunload());

  await openBoard(host);

  assert.equal(host.readFileCalls.length, 0, "no per-file read should be issued");
  assert.equal(host.readFilesCalls.length, 1, "the 25 files should cost one call");
  assert.equal(host.readFilesCalls[0].length, 25);
  assert.equal(host.readFilesCalls[0][0], `${REPO}/stories/${host.files[0]}`);
});

test("does not rebuild the board while the panel is hidden", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];
  assert.ok(watcher, "the plugin should watch the stories directory");

  panel.setVisible(false);
  host.readFilesCalls.length = 0;

  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  assert.equal(panel.updates.length, 0, "a hidden panel must not be re-rendered");
  assert.equal(host.readFilesCalls.length, 0, "a hidden panel must not re-read the files");
});

test("rebuilds once when the panel becomes visible again", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  panel.setVisible(false);
  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  panel.setVisible(true);
  await flush();

  assert.equal(panel.updates.length, 1, "the change missed while hidden should land on re-show");
});

test("chunks a directory larger than the host's batch limit", async (t) => {
  const host = makeHost(1200);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);

  // The host rejects a request above its limit outright, so the plugin must
  // chunk rather than hand it the whole directory and render an empty board.
  assert.ok(host.readFilesCalls.length > 1, "1200 files should be split into chunks");
  assert.ok(host.readFilesCalls.length < 20, "chunking must stay far from one call per file");
  for (const call of host.readFilesCalls) {
    assert.ok(call.length <= 1000, `a chunk of ${call.length} exceeds the host limit`);
  }
  assert.equal(
    host.readFilesCalls.reduce((n, call) => n + call.length, 0),
    1200,
    "every file should still be read",
  );
  assert.ok(panel.options.html.includes("Story 1200"), "the last story should reach the board");
});

test("does not rebuild a hidden board when the repo changes", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  panel.setVisible(false);
  host.readFilesCalls.length = 0;

  host.emitState({ type: "repo-changed" });
  await flush();

  assert.equal(panel.reopened, 0, "a hidden panel must not be reopened and refocused");
  assert.equal(host.readFilesCalls.length, 0, "a hidden panel must not re-read the files");

  panel.setVisible(true);
  await flush();
  assert.equal(panel.updates.length, 1, "the repo change should land when the panel returns");
});

test("stops watching when the panel is closed from the tab bar", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  panel.closeFromTabBar();
  await flush();

  assert.equal(watcher.disposed, true, "a closed board must release its filesystem watch");

  // The handle is dead: a later repo change must not resurrect the panel.
  host.emitState({ type: "repo-changed" });
  await flush();
  assert.equal(panel.reopened, 0, "a closed board must not reopen itself");
});

test("does not write into a panel hidden while the render was in flight", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  // Hide the panel mid-render: the visibility check before the await is not
  // enough on its own.
  const listDirectory = host.listDirectory;
  host.listDirectory = async (...args) => {
    panel.setVisible(false);
    return listDirectory.apply(host, args);
  };

  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  assert.equal(panel.updates.length, 0, "the panel went hidden before the write landed");
});

// ── Drag/drop DOM regression tests ──────────────────────────────────────
//
// The board's card drag is Pointer Events + pointer capture, run inside a
// WKWebView iframe. jsdom has no layout engine and (as of jsdom 30) no
// setPointerCapture/hasPointerCapture/releasePointerCapture at all, so this
// harness stubs both: fixed getBoundingClientRect() rects per column (so the
// script's coordinate-based getColumnAt works) and a capture-call recorder on
// Element.prototype. The script itself is executed exactly as rendered — no
// logic is duplicated or reimplemented for the test.

const COLUMN_ORDER = ["pending", "ready", "in_progress", "blocked", "complete", "wontfix"];
const COLUMN_WIDTH = 150;

/** Load rendered board HTML into jsdom and run its inline script for real. */
function loadBoardDom(html) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;

  const captureCalls = [];
  window.Element.prototype.setPointerCapture = function setPointerCapture(pointerId) {
    this.__captured = this.__captured || new Set();
    this.__captured.add(pointerId);
    captureCalls.push({ op: "set", el: this, pointerId });
  };
  window.Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId) {
    if (this.__captured) this.__captured.delete(pointerId);
    captureCalls.push({ op: "release", el: this, pointerId });
  };
  window.Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId) {
    return !!this.__captured && this.__captured.has(pointerId);
  };

  window.document.querySelectorAll(".column").forEach((col) => {
    const idx = COLUMN_ORDER.indexOf(col.dataset.status);
    const left = Math.max(idx, 0) * COLUMN_WIDTH;
    col.getBoundingClientRect = () => ({
      left, right: left + COLUMN_WIDTH, top: 0, bottom: 600,
      width: COLUMN_WIDTH, height: 600, x: left, y: 0,
    });
  });

  const posted = [];
  window.parent.postMessage = (data) => posted.push(data);

  return { window, document: window.document, posted, captureCalls };
}

// `posted` objects are created inside the jsdom realm (a separate global
// object/Object.prototype from this test file's realm), so assert/strict's
// deepEqual — which is deepStrictEqual and checks prototypes — reports a
// same-structure mismatch even when every field matches. Rebuilding the
// objects as plain literals here normalizes them to this realm.
function plain(messages) {
  return messages.map((m) => ({ ...m }));
}

/** Center-of-column coordinates, matching the fixed rects loadBoardDom installs. */
function pointInColumn(status) {
  const idx = COLUMN_ORDER.indexOf(status);
  return { x: idx * COLUMN_WIDTH + COLUMN_WIDTH / 2, y: 300 };
}

function firePointer(win, target, type, { pointerId = 1, x = 0, y = 0, button = 0 } = {}) {
  target.dispatchEvent(new win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    clientX: x,
    clientY: y,
    button,
  }));
}

/** Board HTML for a single "ready" story, via the same load path openBoard uses. */
async function boardDomWithOneStory() {
  const host = makeHost(1);
  const panel = await openBoard(host);
  return { host, dom: loadBoardDom(panel.options.html) };
}

test("a plain click (no movement) opens the story, not a drag", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const { x, y } = pointInColumn("ready");
  firePointer(window, card, "pointerdown", { x, y });
  firePointer(window, document, "pointerup", { x, y });

  assert.deepEqual(plain(posted), [{ type: "open-story", filename: card.dataset.filename }]);
  assert.equal(captureCalls.length, 0, "a click must never touch pointer capture");
  assert.equal(card.classList.contains("dragging"), false);
});

test("crossing the drag threshold captures the pointer on the card", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, captureCalls } = dom;

  const card = document.querySelector(".card");
  const start = pointInColumn("ready");
  firePointer(window, card, "pointerdown", { x: start.x, y: start.y, pointerId: 7 });
  firePointer(window, document, "pointermove", { x: start.x + 20, y: start.y, pointerId: 7 });

  assert.equal(card.classList.contains("dragging"), true);
  assert.deepEqual(
    captureCalls.map((c) => ({ op: c.op, pointerId: c.pointerId })),
    [{ op: "set", pointerId: 7 }],
  );
  assert.equal(document.querySelectorAll(".drag-ghost").length, 1);

  // cleanup so the harness doesn't leak a dangling drag into other assertions
  firePointer(window, document, "pointerup", { x: start.x + 20, y: start.y, pointerId: 7 });
});

test("dropping on a different column emits status-change and releases capture", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const from = pointInColumn("ready");
  const to = pointInColumn("in_progress");

  firePointer(window, card, "pointerdown", { x: from.x, y: from.y, pointerId: 3 });
  firePointer(window, document, "pointermove", { x: from.x + 20, y: from.y, pointerId: 3 });
  firePointer(window, document, "pointermove", { x: to.x, y: to.y, pointerId: 3 });
  firePointer(window, document, "pointerup", { x: to.x, y: to.y, pointerId: 3 });

  assert.deepEqual(plain(posted), [{
    type: "status-change",
    storyId: card.dataset.storyId,
    filename: card.dataset.filename,
    oldStatus: "ready",
    newStatus: "in_progress",
    title: card.dataset.title,
  }]);
  assert.deepEqual(
    captureCalls.map((c) => c.op),
    ["set", "release"],
    "the pointer must be released exactly once, after the set",
  );
  assert.equal(card.classList.contains("dragging"), false);
  assert.equal(document.querySelectorAll(".drag-ghost").length, 0, "the ghost must be removed");
  assert.equal(document.querySelectorAll(".column.drop-target").length, 0);
});

test("dropping back in the same column emits nothing but still cleans up", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const p = pointInColumn("ready");

  firePointer(window, card, "pointerdown", { x: p.x, y: p.y, pointerId: 4 });
  firePointer(window, document, "pointermove", { x: p.x + 30, y: p.y, pointerId: 4 });
  firePointer(window, document, "pointerup", { x: p.x, y: p.y, pointerId: 4 });

  assert.deepEqual(posted, [], "no status-change when the drop column matches the source column");
  assert.deepEqual(captureCalls.map((c) => c.op), ["set", "release"]);
  assert.equal(card.classList.contains("dragging"), false);
  assert.equal(document.querySelectorAll(".drag-ghost").length, 0);
});

test("pointercancel mid-drag cleans up and emits nothing", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const p = pointInColumn("ready");

  firePointer(window, card, "pointerdown", { x: p.x, y: p.y, pointerId: 9 });
  firePointer(window, document, "pointermove", { x: p.x + 30, y: p.y, pointerId: 9 });
  firePointer(window, document, "pointercancel", { x: p.x + 30, y: p.y, pointerId: 9 });

  assert.deepEqual(posted, [], "cancellation must never emit a status-change");
  assert.equal(card.classList.contains("dragging"), false);
  assert.equal(document.querySelectorAll(".drag-ghost").length, 0);
  // The UA releases capture itself before firing pointercancel — the handler
  // only needs to clear local state, not call releasePointerCapture again.
  assert.deepEqual(captureCalls.map((c) => c.op), ["set"]);

  // A stray pointerup for the same (now-cancelled) pointer must be inert.
  firePointer(window, document, "pointerup", { x: p.x + 30, y: p.y, pointerId: 9 });
  assert.deepEqual(posted, []);
});

test("pointerup dispatched at the document (not the card) still completes the drag", async (t) => {
  // Regression for the WKWebView failure this fix targets: capture guarantees
  // delivery for the pointerId regardless of which element the platform
  // treats as "under" the pointer at release time. The handler must not
  // depend on e.target being the card or any element still in view — it
  // reads e.pointerId and clientX/Y and is registered on document.
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const from = pointInColumn("ready");
  const to = pointInColumn("blocked");

  firePointer(window, card, "pointerdown", { x: from.x, y: from.y, pointerId: 2 });
  firePointer(window, document, "pointermove", { x: to.x, y: to.y, pointerId: 2 });
  // Dispatch directly on document, far from the card, as capture-routed
  // events reaching only the document listener would look.
  firePointer(window, document.documentElement, "pointerup", { x: to.x, y: to.y, pointerId: 2 });

  assert.deepEqual(plain(posted), [{
    type: "status-change",
    storyId: card.dataset.storyId,
    filename: card.dataset.filename,
    oldStatus: "ready",
    newStatus: "blocked",
    title: card.dataset.title,
  }]);
  assert.deepEqual(captureCalls.map((c) => c.op), ["set", "release"]);
});

test("a second pointer's events are ignored while a drag is in progress", async (t) => {
  const { dom } = await boardDomWithOneStory();
  t.after(() => plugin.onunload());
  const { window, document, posted, captureCalls } = dom;

  const card = document.querySelector(".card");
  const p = pointInColumn("ready");
  const other = pointInColumn("blocked");

  firePointer(window, card, "pointerdown", { x: p.x, y: p.y, pointerId: 1 });
  firePointer(window, document, "pointermove", { x: p.x + 20, y: p.y, pointerId: 1 });
  // An unrelated pointer (e.g. a second touch) must not hijack or end the drag.
  firePointer(window, document, "pointerup", { x: other.x, y: other.y, pointerId: 99 });

  assert.deepEqual(posted, [], "the unrelated pointer must not complete the drag");
  assert.equal(card.classList.contains("dragging"), true, "the real drag must still be active");

  firePointer(window, document, "pointerup", { x: other.x, y: other.y, pointerId: 1 });
  assert.equal(posted.length, 1, "the owning pointer's up should still complete the drag");
});

test("does not rebuild on re-show when nothing changed while hidden", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);

  panel.setVisible(false);
  await flush();
  panel.setVisible(true);
  await flush();

  assert.equal(panel.updates.length, 0, "no watch event means no work to catch up on");
});
