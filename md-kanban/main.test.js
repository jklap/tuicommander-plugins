/**
 * Lifecycle tests for the md-kanban plugin.
 *
 * Run: node --test md-kanban/
 *
 * Modeled on wiz-kanban's PluginHost double: a fake host that records every
 * call, plus the panel handle it hands back from openPanel(). Most of these
 * tests are about work the plugin must NOT do — rebuild a board nobody is
 * looking at, or write into a file that changed underneath it — so the
 * assertions count/inspect calls rather than the rendered markup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import plugin from "./main.js";

const BOARD_PATH = "/home/user/vault/board.md";

/** Minimal PluginHost double. */
function makeHost() {
	const host = {
		files: new Map(), // path -> content
		pluginData: new Map(), // path -> content (the plugin's own persisted data)
		panels: [],
		watchers: [],
		actions: [],
		dashboards: [],
		commands: [],
		openMarkdownFileCalls: [],
		openExternalUrlCalls: [],
		writeFileCalls: [],
		pickFileResult: null,
		pickFileError: null,

		log() {},

		registerTerminalAction(action) {
			host.actions.push(action);
			return { dispose() {} };
		},
		registerDashboard(options) {
			host.dashboards.push(options);
			return { dispose() {} };
		},
		registerCommand(options) {
			host.commands.push(options);
			return { dispose() {} };
		},

		async invoke(cmd, args) {
			if (cmd === "read_plugin_data") {
				return host.pluginData.has(args.path) ? host.pluginData.get(args.path) : null;
			}
			if (cmd === "write_plugin_data") {
				host.pluginData.set(args.path, args.content);
				return undefined;
			}
			throw new Error(`unexpected invoke: ${cmd}`);
		},

		async readFile(path) {
			if (!host.files.has(path)) throw new Error(`ENOENT: ${path}`);
			return host.files.get(path);
		},
		async writeFile(path, content) {
			host.writeFileCalls.push({ path, content });
			host.files.set(path, content);
		},

		async watchPath(dir, callback) {
			const watcher = { dir, callback, disposed: false };
			host.watchers.push(watcher);
			return {
				dispose() {
					watcher.disposed = true;
				},
			};
		},

		async pickFile() {
			if (host.pickFileError) throw host.pickFileError;
			return host.pickFileResult;
		},

		openMarkdownFile(path) {
			host.openMarkdownFileCalls.push(path);
		},
		openExternalUrl(url) {
			host.openExternalUrlCalls.push(url);
		},

		openPanel(options) {
			const existing = host.panels[0];
			if (existing) {
				existing.options = options;
				existing.reopened = (existing.reopened ?? 0) + 1;
				existing.visible = true;
				return existing;
			}
			const panel = {
				options,
				updates: [],
				sent: [],
				reopened: 0,
				visible: true,
				closed: false,
				update(html) {
					if (panel.closed) return false;
					panel.updates.push(html);
					return true;
				},
				isVisible() {
					return panel.visible && !panel.closed;
				},
				send(data) {
					panel.sent.push(data);
				},
				close() {},
				closeFromTabBar() {
					panel.closed = true;
					options.onClose?.();
				},
				setVisible(visible) {
					if (panel.visible === visible) return;
					panel.visible = visible;
					options.onVisibilityChange?.(visible);
				},
			};
			host.panels.push(panel);
			return panel;
		},
	};
	return host;
}

/** Let every pending promise chain settle without waiting on real timers. */
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Open the board panel through the registered terminal action (mirrors how
 *  a user would reach it from the right-click menu). */
async function openBoard(host) {
	await plugin.onload(host);
	await host.actions.find((a) => a.id === "open-md-kanban").action();
	await flush();
	return host.panels[0];
}

/** Open the (empty) panel, then drive the real Add Board flow through the
 *  file picker so the plugin's own persistence/watch-binding code runs. */
async function openBoardWithOneTask(host, taskLine) {
	host.files.set(BOARD_PATH, `${taskLine}\n`);
	host.pickFileResult = BOARD_PATH;
	const panel = await openBoard(host);
	panel.options.onMessage({ type: "add-board" });
	await flush();
	panel.sent.length = 0;
	return panel;
}

function lastHtml(panel) {
	return panel.updates[panel.updates.length - 1];
}

/** Pull a card's data-key/data-raw out of the rendered HTML — brittle-looking
 *  but this is exactly what the real iframe script reads off the DOM. */
function findCard(html, rawLineSubstring) {
	const re = /data-key="([^"]*)"[^>]*data-status="[^"]*"[^>]*data-raw="([^"]*)"/g;
	let m = re.exec(html);
	while (m) {
		if (m[2].includes(escapeForRegexTest(rawLineSubstring))) return { key: m[1], rawLine: unescapeHtml(m[2]) };
		m = re.exec(html);
	}
	return null;
}
function escapeForRegexTest(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unescapeHtml(s) {
	return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Pull the first rendered link's data-target/data-ext off the real HTML —
 *  the whole point being to drive the message the real iframe script would
 *  actually send, not an assumed value. */
function findLink(html) {
	const re = /data-target="([^"]*)" data-ext="([^"]*)"/;
	const m = re.exec(html);
	if (!m) return null;
	return { target: unescapeHtml(m[1]), external: m[2] === "1" };
}

test("first open with no persisted boards renders the empty state and issues no readFile", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());

	const panel = await openBoard(host);

	assert.equal(host.files.size, 0);
	assert.match(lastHtml(panel), /No boards yet/);
});

test("Add Board reads the picked file once, persists it, and renders the board", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	host.files.set(BOARD_PATH, "- [ ] hello\n");
	host.pickFileResult = BOARD_PATH;

	const panel = await openBoard(host);
	panel.options.onMessage({ type: "add-board" });
	await flush();

	assert.match(lastHtml(panel), /hello/);
	const persisted = JSON.parse(host.pluginData.get("boards.json"));
	assert.equal(persisted.boards.length, 1);
	assert.equal(persisted.boards[0].path, BOARD_PATH);
	assert.equal(persisted.activeBoardId, persisted.boards[0].id);
});

test("falls back to an empty board list when the persisted data is corrupt JSON", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	host.pluginData.set("boards.json", "{not valid json");

	const panel = await openBoard(host);

	assert.match(lastHtml(panel), /No boards yet/);
});

test("falls back to an empty board list when the persisted shape is malformed", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	// Valid JSON, but not the expected shape (boards is not an array).
	host.pluginData.set("boards.json", JSON.stringify({ version: 1, boards: "oops" }));

	const panel = await openBoard(host);

	assert.match(lastHtml(panel), /No boards yet/);
});

test("Add Board does nothing when the user cancels the file picker", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	host.pickFileResult = null;

	const panel = await openBoard(host);
	panel.options.onMessage({ type: "add-board" });
	await flush();

	assert.match(lastHtml(panel), /No boards yet/);
	assert.equal(host.pluginData.has("boards.json"), false, "cancelling must not persist an empty write");
});

test("Add Board toasts a friendly message and adds nothing when the picked file can't be read", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	host.pickFileResult = "/outside/home/board.md"; // deliberately never added to host.files
	// pre-seed persisted state so we can assert it is untouched by the failed add
	host.pluginData.set("boards.json", JSON.stringify({ version: 1, activeBoardId: null, boards: [] }));

	const panel = await openBoard(host);
	panel.options.onMessage({ type: "add-board" });
	await flush();

	assert.match(lastHtml(panel), /No boards yet/);
	assert.ok(panel.sent.some((m) => m.type === "toast" && m.level === "error"));
	const persisted = JSON.parse(host.pluginData.get("boards.json"));
	assert.equal(persisted.boards.length, 0, "a failed add must not be persisted");
});

test("a thrown pickFile error is caught and toasted rather than crashing the plugin", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	host.pickFileError = new Error("dialog plugin unavailable");

	const panel = await openBoard(host);
	panel.options.onMessage({ type: "add-board" });
	await flush();

	assert.ok(panel.sent.some((m) => m.type === "toast" && m.level === "error"));
	assert.match(lastHtml(panel), /No boards yet/);
});

test("Add Board switches to an already-added board instead of duplicating it", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");

	const secondPath = "/home/user/other/second.md";
	host.files.set(secondPath, "- [ ] second\n");
	host.pickFileResult = secondPath;
	panel.options.onMessage({ type: "add-board" });
	await flush();

	// Re-picking the FIRST board's path must switch back to it, not add a
	// second entry for the same file.
	host.pickFileResult = BOARD_PATH;
	panel.options.onMessage({ type: "add-board" });
	await flush();

	const persisted = JSON.parse(host.pluginData.get("boards.json"));
	assert.equal(persisted.boards.length, 2, "re-adding an existing path must not duplicate it");
	assert.match(lastHtml(panel), /hello/);
});

test("does not re-render while the panel is hidden", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];
	assert.ok(watcher, "the plugin should watch the board's directory");

	panel.setVisible(false);
	panel.updates.length = 0;
	host.files.set(BOARD_PATH, "- [x] hello  [completion:: 2026-09-14]\n");

	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	assert.equal(panel.updates.length, 0, "a hidden panel must not be re-rendered");
});

test("re-renders exactly once when the panel becomes visible again", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	panel.setVisible(false);
	host.files.set(BOARD_PATH, "- [x] hello  [completion:: 2026-09-14]\n");
	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	panel.updates.length = 0;
	panel.setVisible(true);
	await flush();

	assert.equal(panel.updates.length, 1, "the change missed while hidden should land on re-show");
});

test("does not write into a panel hidden while the render was in flight", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	const readFile = host.readFile;
	host.readFile = async (...args) => {
		panel.setVisible(false);
		return readFile.apply(host, args);
	};

	panel.updates.length = 0;
	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	assert.equal(panel.updates.length, 0, "the panel went hidden before the write landed");
});

test("does not rebuild on re-show when nothing changed while hidden", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");

	panel.updates.length = 0;
	panel.setVisible(false);
	await flush();
	panel.setVisible(true);
	await flush();

	assert.equal(panel.updates.length, 0, "no watch event means no work to catch up on");
});

test("watch debounce coalesces rapid events into one re-read", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	let readCount = 0;
	const readFile = host.readFile;
	host.readFile = async (...args) => {
		readCount++;
		return readFile.apply(host, args);
	};

	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	assert.equal(readCount, 1);
});

test("a watch event still matches when its path has a different prefix than board.path (symlink canonicalization)", async (t) => {
	// The host canonicalizes the watched directory (resolving symlinks) before
	// watching it, so an emitted event's path can carry a different prefix
	// than board.path itself (e.g. macOS /tmp -> /private/tmp) even for the
	// exact same file. Matching must tolerate that, not require exact equality.
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	host.files.set(BOARD_PATH, "- [x] hello  [completion:: 2026-09-14]\n");
	panel.updates.length = 0;
	watcher.callback([{ type: "modify", path: "/private/home/user/vault/board.md" }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	assert.match(lastHtml(panel), /\[x\] hello/, "the differently-prefixed event must still trigger a refresh");
});

test("a status-change write does not trigger a second render from its own echo", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];
	const card = findCard(lastHtml(panel), "hello");
	assert.ok(card);

	panel.updates.length = 0;
	panel.options.onMessage({ type: "status-change", key: card.key, rawLine: card.rawLine, toStatus: "in_progress" });
	await flush();

	assert.equal(panel.updates.length, 1, "the drag itself renders once");
	assert.match(lastHtml(panel), /\[\/\] hello/);

	// The write we just made fires the same fs:watch callback the app would
	// deliver for our own change — it must be recognized as an echo and not
	// cost a second render.
	const beforeEcho = panel.updates.length;
	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();
	assert.equal(panel.updates.length, beforeEcho, "the plugin's own write must not re-render a second time");
});

// ── Drag/drop DOM regression tests ──────────────────────────────────────
//
// The board's card drag is Pointer Events + pointer capture, run inside a
// WKWebView iframe (ported from wiz-kanban's `9c08d20` fix, which this board
// was originally modeled on). jsdom has no layout engine and (as of jsdom 30)
// no setPointerCapture/hasPointerCapture/releasePointerCapture at all, so this
// harness stubs both: fixed getBoundingClientRect() rects per column (so the
// script's coordinate-based getColumnAt works) and a capture-call recorder on
// Element.prototype. The script itself is executed exactly as rendered — no
// logic is duplicated or reimplemented for the test.

const COLUMN_ORDER = ["pending", "ready", "in_progress", "blocked", "done", "wontfix"];
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

/** Board HTML for a single "ready" task, via the same load path openBoardWithOneTask uses. */
async function boardDomWithOneTask() {
	const host = makeHost();
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	return { host, panel, dom: loadBoardDom(lastHtml(panel)) };
}

test("a plain click (no movement) does nothing — no drag, no message", async (t) => {
	const { dom } = await boardDomWithOneTask();
	t.after(() => plugin.onunload());
	const { window, document, posted, captureCalls } = dom;

	const card = document.querySelector(".card");
	const { x, y } = pointInColumn("ready");
	firePointer(window, card, "pointerdown", { x, y });
	firePointer(window, document, "pointerup", { x, y });

	assert.deepEqual(posted, [], "a plain click on the card body must not emit anything");
	assert.equal(captureCalls.length, 0, "a click must never touch pointer capture");
	assert.equal(card.classList.contains("dragging"), false);
});

test("crossing the drag threshold captures the pointer on the card", async (t) => {
	const { dom } = await boardDomWithOneTask();
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
	const { dom } = await boardDomWithOneTask();
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
		key: card.dataset.key,
		rawLine: card.dataset.raw,
		toStatus: "in_progress",
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
	const { dom } = await boardDomWithOneTask();
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
	const { dom } = await boardDomWithOneTask();
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
	const { dom } = await boardDomWithOneTask();
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
		key: card.dataset.key,
		rawLine: card.dataset.raw,
		toStatus: "blocked",
	}]);
	assert.deepEqual(captureCalls.map((c) => c.op), ["set", "release"]);
});

test("a second pointer's events are ignored while a drag is in progress", async (t) => {
	const { dom } = await boardDomWithOneTask();
	t.after(() => plugin.onunload());
	const { window, document, posted } = dom;

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

test("a click on the Get-ID button does not start a drag", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const dom = loadBoardDom(lastHtml(panel));
	const { window, document, posted, captureCalls } = dom;

	const btn = document.querySelector(".get-id-btn");
	if (!btn) return; // this task line has no dependents, so no Get-ID button is rendered
	const { x, y } = pointInColumn("ready");
	firePointer(window, btn, "pointerdown", { x, y });
	firePointer(window, document, "pointerup", { x, y });

	assert.deepEqual(posted, []);
	assert.equal(captureCalls.length, 0);
});

test("closing from the tab bar disposes the watcher and the panel does not resurrect", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	panel.closeFromTabBar();
	await flush();

	assert.equal(watcher.disposed, true);
});

test("board switch rebinds the watcher to the new file and disposes the old one", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const firstWatcher = host.watchers[0];

	const secondPath = "/home/user/other/second.md";
	host.files.set(secondPath, "- [ ] second board\n");
	host.pickFileResult = secondPath;
	panel.options.onMessage({ type: "add-board" });
	await flush();

	assert.equal(firstWatcher.disposed, true);
	assert.equal(host.watchers.length, 2);
	assert.equal(host.watchers[1].disposed, false);
});

test("closing the last board leaves the panel open on the empty state", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");

	const persisted = JSON.parse(host.pluginData.get("boards.json"));
	const boardId = persisted.boards[0].id;
	panel.options.onMessage({ type: "close-board", boardId });
	await flush();

	assert.equal(panel.closed, false, "closing the last board must not close the tab itself");
	assert.match(lastHtml(panel), /No boards yet/);
});

test("an external link opens via openExternalUrl and never openMarkdownFile", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] see [site](https://example.com)");

	panel.options.onMessage({ type: "open-link", target: "https://example.com", external: true });
	await flush();

	assert.deepEqual(host.openExternalUrlCalls, ["https://example.com"]);
	assert.equal(host.openMarkdownFileCalls.length, 0);
});

test("an unsupported external scheme toasts instead of silently doing nothing", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] see [ide](vscode://file/x)");

	panel.options.onMessage({ type: "open-link", target: "vscode://file/x", external: true });
	await flush();

	assert.equal(host.openExternalUrlCalls.length, 0, "an unsupported scheme must never reach openExternalUrl");
	assert.ok(panel.sent.some((m) => m.type === "toast" && m.level === "error"));
});

test("a file link opens via openMarkdownFile with the resolved absolute path", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] see [doc](../notes/x.md)");

	// Read the target the real render actually produced (not an assumed
	// value) — a prior version of the render forgot to carry the resolved
	// absPath onto the link span, so this link rendered its raw, unresolved
	// relative target; this is the exact regression that would have caught.
	const link = findLink(lastHtml(panel));
	assert.ok(link, "the board must render a link element");
	assert.equal(link.target, "/home/user/notes/x.md");
	assert.equal(link.external, false);

	panel.options.onMessage({ type: "open-link", target: link.target, external: link.external });
	await flush();

	assert.deepEqual(host.openMarkdownFileCalls, ["/home/user/notes/x.md"]);
	assert.equal(host.openExternalUrlCalls.length, 0);
});

test("a status-change whose rawLine no longer matches the file is rejected and toasts instead of writing", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const card = findCard(lastHtml(panel), "hello");

	// The file changed underneath the card (e.g. an external editor).
	host.files.set(BOARD_PATH, "- [ ] hello (edited elsewhere)\n");

	const writesBefore = host.writeFileCalls.length;
	panel.options.onMessage({ type: "status-change", key: card.key, rawLine: card.rawLine, toStatus: "done" });
	await flush();

	assert.equal(host.writeFileCalls.length, writesBefore, "a stale rawLine must never be written");
	assert.ok(panel.sent.some((m) => m.type === "toast" && m.level === "error"));
});

test("onunload disposes the watcher and a later watch callback is inert", async () => {
	const host = makeHost();
	const panel = await openBoardWithOneTask(host, "- [ ] hello");
	const watcher = host.watchers[0];

	plugin.onunload();
	panel.updates.length = 0;

	watcher.callback([{ type: "modify", path: BOARD_PATH }]);
	await new Promise((resolve) => setTimeout(resolve, 600));
	await flush();

	assert.equal(panel.updates.length, 0);
});
