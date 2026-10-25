import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildPanelHtml } from "./main.js";
import { createRequire } from "node:module";
import vm from "node:vm";

async function panel() {
	const loader = new URL("./vendor/sql-wasm.js", import.meta.url);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(loader, "utf8"), {
		module,
		exports: module.exports,
		require: createRequire(import.meta.url),
		process,
		__dirname: import.meta.dirname,
		console,
		Buffer,
		setTimeout,
		clearTimeout,
		TextDecoder,
		TextEncoder,
		WebAssembly,
	});
	const wasmBuffer = fs.readFileSync(new URL("./vendor/sql-wasm.wasm", import.meta.url));
	const SQL = await module.exports({ wasmBinary: wasmBuffer });
	const db = new SQL.Database();
	db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1, 'alpha');");
	const databaseBuffer = Uint8Array.from(db.export()).buffer;
	db.close();
	const dom = new JSDOM(buildPanelHtml("sample.sqlite", "", ""), { runScripts: "outside-only" });
	const { window } = dom;
	window.ArrayBuffer = ArrayBuffer;
	window.Uint8Array = Uint8Array;
	window.initSqlJs = async () => SQL;
	window.eval(fs.readFileSync(new URL("./panel.bundle.js", import.meta.url), "utf8"));
	const send = (payload) =>
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: { type: "tuic:host-message", payload },
			}),
		);
	const load = async () => {
		send({ type: "load-database", path: "/sample.sqlite", databaseBuffer, wasmBuffer: wasmBuffer.buffer });
		await new Promise(setImmediate);
	};
	return {
		dom,
		window,
		send,
		load,
		document: window.document,
		close() {
			window.dispatchEvent(new window.Event("pagehide"));
			window.close();
		},
	};
}

// Catches: listening for a raw load-database silently discards PanelHandle.send's envelope.
test("panel receives wrapped load-database and renders actual SQLite rows", async () => {
	const p = await panel();
	try {
		await p.load();
		assert.equal(p.document.querySelector("#workspace").hidden, false);
		assert.match(p.document.querySelector("#rows").textContent, /alpha/);
		assert.equal(p.document.querySelector("#row-count").textContent, "1");
	} finally {
		p.close();
	}
});

// Catches: host read failures remain hidden behind the loading placeholder.
test("panel displays wrapped load-error", async () => {
	const p = await panel();
	try {
		p.send({ type: "load-error", message: "File exceeds maximum size" });
		assert.equal(p.document.querySelector("#fatal").hidden, false);
		assert.match(p.document.querySelector("#fatal").textContent, /File exceeds maximum size/);
	} finally {
		p.close();
	}
});

// Catches: an enveloped save acknowledgement leaves the viewer stuck in SAVING.
test("panel settles wrapped save-result only for the active request", async () => {
	const p = await panel();
	try {
		await p.load();
		p.document.querySelector("#edit-mode").click();
		const cell = p.document.querySelector("td.editable");
		cell.dispatchEvent(new p.window.MouseEvent("dblclick"));
		const input = cell.querySelector("input");
		input.value = "updated";
		input.dispatchEvent(new p.window.Event("blur"));
		p.document.querySelector("#save-changes").click();
		p.send({ type: "save-result", requestId: 999, ok: true });
		assert.equal(p.document.querySelector("#dirty-state").textContent, "SAVING…");
		p.send({ type: "save-result", requestId: 1, ok: true });
		assert.equal(p.document.querySelector("#dirty-state").hidden, true);
		assert.equal(p.document.querySelector("#save-changes").textContent, "Save changes");
	} finally {
		p.close();
	}
});

// Catches: unrelated SDK or raw events are mistaken for host application messages.
test("panel ignores unrelated and unwrapped messages", async () => {
	const p = await panel();
	try {
		for (const data of [null, { type: "tuic:theme-changed" }, { type: "load-error", message: "wrong" }]) {
			p.window.dispatchEvent(new p.window.MessageEvent("message", { data }));
		}
		assert.equal(p.document.querySelector("#fatal").hidden, true);
	} finally {
		p.close();
	}
});
