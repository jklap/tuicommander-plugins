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

test("a file link opens via openMarkdownFile with the resolved absolute path", async (t) => {
	const host = makeHost();
	t.after(() => plugin.onunload());
	const panel = await openBoardWithOneTask(host, "- [ ] see [doc](../notes/x.md)");

	// The plugin's render already resolved this to an absolute path — the
	// message contract carries that resolved path, not the raw relative one.
	panel.options.onMessage({ type: "open-link", target: "/home/user/notes/x.md", external: false });
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
