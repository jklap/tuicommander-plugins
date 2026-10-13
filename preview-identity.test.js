import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = globalThis;
const { default: csv } = await import("./csv-preview/main.js");
const { default: docx } = await import("./docx-preview/main.js");
const { default: xlsx } = await import("./xlsx-preview/main.js");

for (const [extension, plugin] of [["csv", csv], ["docx", docx], ["xlsx", xlsx]]) {
  // Catches: identical names from two repositories overwrite the same panel.
  test(`${extension} keeps equal relative file names in different roots in separate panels`, async (t) => {
    let preview;
    const panels = new Map(); const ids = []; const reads = []; const edits = [];
    const workbook = globalThis.XLSX.utils.book_new();
    globalThis.XLSX.utils.book_append_sheet(workbook, globalThis.XLSX.utils.aoa_to_sheet([["Real workbook"]]), "Data");
    const h = {
      registerFilePreview(entry) { preview = entry.onOpen; },
      async readFile(path) { reads.push(path); return "Name\nCSV data"; },
      async readFileBase64(path) {
        reads.push(path);
        return extension === "xlsx" ? globalThis.XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) : "";
      },
      openPanel(panel) { ids.push(panel.id); panels.set(panel.id, panel); },
      openEditorTab(...args) { edits.push(args); },
    };
    plugin.onload(h); t.after(() => plugin.onunload());
    for (const root of ["/a", "/b", "/a"]) {
      await preview({ fsRoot: root, repoPath: root, filePath: `report.${extension}` });
    }
    assert.equal(panels.size, 2);
    assert.equal(ids[0], ids[2], "same absolute file reuses its panel");
    assert.deepEqual(reads, [`/a/report.${extension}`, `/b/report.${extension}`, `/a/report.${extension}`]);
    if (extension !== "docx") {
      panels.get(ids[1]).onMessage({ type: "edit" });
      assert.deepEqual(edits, [[`report.${extension}`, "/b", { fsRoot: "/b" }]]);
    }
  });
}
