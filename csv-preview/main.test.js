/**
 * Tests for the CSV Preview plugin.
 *
 * Run: node --test plugins/csv-preview/
 *
 * Driven through a PluginHost double: the input is file text, the output is the
 * panel HTML. The inline script is executed the way a browser would run it — cut
 * at the first closing script tag — because a cell that ends the script element
 * early is a bug only visible there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const { default: plugin } = await import("./main.js");

/** Open `raw` through the plugin and return the panel HTML. */
async function previewHtml(raw, filePath = "data.csv") {
	let opened;
	let handler;
	plugin.onload({
		registerFilePreview: (h) => {
			handler = h;
		},
		readFile: async () => raw,
		openPanel: (p) => {
			opened = p;
		},
		openEditorTab: () => {},
	});
	await handler.onOpen({ filePath });
	return opened.html;
}

/** Run the panel's inline script, sort by column 0, return the rendered tbody. */
function sortedBody(html) {
	const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
	const body = { innerHTML: "" };
	const sandbox = {
		document: {
			getElementById: (id) => (id === "csv-body" ? body : { textContent: "" }),
		},
		window: { parent: { postMessage() {} } },
	};
	vm.runInNewContext(`${script}\nsortByCol(0);`, sandbox);
	return body.innerHTML;
}

/** Cell text of every body row, read back from the static table. */
function staticRows(html) {
	const tbody = html.match(/<tbody id="csv-body">([\s\S]*?)<\/tbody>/)[1];
	return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
		[...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]),
	);
}

test("a cell containing </script> keeps sorting working and renders literally", async () => {
	const html = await previewHtml("h\nb</script><b>x\na\n");
	const body = sortedBody(html);
	assert.match(body, /<td>a<\/td>.*<td>b&lt;\/script&gt;&lt;b&gt;x<\/td>/);
});

test("a final line ending with a delimiter keeps its trailing empty field", async () => {
	// Without a closing newline the parser used to stop right after the delimiter.
	assert.match(await previewHtml("a,b,"), /0 rows, 3 cols/);
	assert.match(await previewHtml('"a","b",'), /0 rows, 3 cols/);
	assert.match(await previewHtml("a\tb\t", "data.tsv"), /0 rows, 3 cols/);
});

test("a final line of only a delimiter yields two empty fields", async () => {
	assert.match(await previewHtml(","), /0 rows, 2 cols/);
});

test("quoted delimiters, quoted newlines and CRLF still parse", async () => {
	const html = await previewHtml('a,b\r\n"x,y","l1\nl2"\r\nz,w\r\n');
	assert.deepEqual(staticRows(html), [
		["x,y", "l1\nl2"],
		["z", "w"],
	]);
});
