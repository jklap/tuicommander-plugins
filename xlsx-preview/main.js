import "./vendor/xlsx.full.min.js";

const PLUGIN_ID = "xlsx-preview";
const MAX_PANEL_TITLE = 48;
/** Rows kept per sheet. A workbook is embedded whole in the panel HTML, so this bounds the payload. */
const MAX_DISPLAY_ROWS = 2000;
/** Columns kept per sheet. Spreadsheets often carry hundreds of empty trailing columns. */
const MAX_DISPLAY_COLS = 200;

const xlsxApi = globalThis.XLSX;

export default {
	id: PLUGIN_ID,
	onload(host) {
		host.registerFilePreview({
			extensions: ["xlsx", "xlsm", "xltx", "xltm", "xlsb", "xls", "ods", "fods"],
			async onOpen(ctx) {
				try {
					if (!xlsxApi?.read || !xlsxApi?.utils?.sheet_to_json) {
						throw new Error("SheetJS did not initialize");
					}

					const abs = absolutePath(ctx.fsRoot, ctx.filePath);
					const base64 = await host.readFileBase64(abs);
					const workbook = xlsxApi.read(base64ToUint8Array(base64), {
						type: "array",
						cellDates: true,
					});
					const fileName = basename(ctx.filePath);

					host.openPanel({
						id: panelId(ctx.filePath),
						title: shortTitle(fileName),
						html: buildPanelHtml(fileName, readSheets(workbook)),
						onMessage(data) {
							if (data && typeof data === "object" && data.type === "edit") {
								host.openEditorTab(ctx.filePath, ctx.repoPath, { fsRoot: ctx.fsRoot });
							}
						},
					});
				} catch (error) {
					host.openPanel({
						id: panelId(ctx.filePath),
						title: shortTitle(basename(ctx.filePath)),
						html: buildErrorHtml(ctx.filePath, error),
					});
				}
			},
		});
	},
	onunload() {},
};

/**
 * Flatten every worksheet to a rectangular array of display strings.
 *
 * `raw: false` asks SheetJS for the formatted value each cell shows in Excel,
 * so dates, percentages and currencies read the way the author wrote them and
 * every cell is already a string — which is what the table renderer sorts.
 */
function readSheets(workbook) {
	return (workbook.SheetNames ?? []).map((name) => {
		const worksheet = workbook.Sheets[name];
		const raw = worksheet
			? xlsxApi.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: "", blankrows: false })
			: [];

		const totalRows = raw.length;
		const totalCols = raw.reduce((max, row) => Math.max(max, row.length), 0);
		const colCount = Math.min(totalCols, MAX_DISPLAY_COLS);
		const rows = raw.slice(0, MAX_DISPLAY_ROWS).map((row) => {
			const cells = new Array(colCount);
			for (let c = 0; c < colCount; c++) cells[c] = row[c] == null ? "" : String(row[c]);
			return cells;
		});

		return { name, rows, totalRows, totalCols };
	});
}

function absolutePath(root, filePath) {
	if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\")) return filePath;
	if (!root) return filePath;
	const sep = root.includes("\\") ? "\\" : "/";
	return root.replace(/[\\/]+$/, "") + sep + filePath.replace(/^[\\/]+/, "");
}

function basename(path) {
	const normalized = String(path).replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function shortTitle(name) {
	if (name.length <= MAX_PANEL_TITLE) return name;
	const extAt = name.lastIndexOf(".");
	const ext = extAt > 0 ? name.slice(extAt) : "";
	return `${name.slice(0, MAX_PANEL_TITLE - ext.length - 3)}...${ext}`;
}

function panelId(filePath) {
	let hash = 2166136261;
	for (let i = 0; i < filePath.length; i++) {
		hash ^= filePath.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `xlsx-${(hash >>> 0).toString(16)}`;
}

function base64ToUint8Array(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function esc(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Embed data in a <script> block without letting a cell value close the tag. */
function escScript(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildPanelHtml(fileName, sheets) {
	if (sheets.length === 0) {
		return `<div class="empty-state">No sheets in this workbook<div class="hint">${esc(fileName)}</div></div>`;
	}

	const sheetTabs = sheets
		.map(
			(sheet, index) =>
				`<button type="button" class="xl-tab" data-sheet="${index}" aria-pressed="${index === 0}">${esc(sheet.name)}</button>`,
		)
		.join("");

	return `
<style>
	.xl-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border, #3e3e42);
	}
	.xl-toolbar .info {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85em;
		opacity: 0.7;
	}
	.xl-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 12px 0;
	}
	.xl-tab[aria-pressed="true"] {
		border-color: var(--accent, #59a8dd);
		background: color-mix(in srgb, var(--accent, #59a8dd) 18%, transparent);
	}
	.xl-notice { padding: 8px 12px 0; }
	.xl-grid { padding: 8px 12px 24px; overflow-x: auto; }
	.xl-grid thead { position: sticky; top: 0; z-index: 1; background: var(--bg-primary, #1e1e1e); }
	.xl-grid th { cursor: pointer; white-space: nowrap; }
	.xl-grid td { white-space: pre-wrap; }
	.xl-grid .sort-arrow { font-size: 0.75em; opacity: 0.6; }
	td.xl-c0 { background: hsla(210, 50%, 50%, 0.04); } th.xl-c0 { background: hsla(210, 50%, 40%, 0.12); }
	td.xl-c1 { background: hsla(160, 50%, 50%, 0.04); } th.xl-c1 { background: hsla(160, 50%, 40%, 0.12); }
	td.xl-c2 { background: hsla(30, 50%, 50%, 0.04); } th.xl-c2 { background: hsla(30, 50%, 40%, 0.12); }
	td.xl-c3 { background: hsla(340, 50%, 50%, 0.04); } th.xl-c3 { background: hsla(340, 50%, 40%, 0.12); }
	td.xl-c4 { background: hsla(120, 50%, 50%, 0.04); } th.xl-c4 { background: hsla(120, 50%, 40%, 0.12); }
	td.xl-c5 { background: hsla(270, 50%, 50%, 0.04); } th.xl-c5 { background: hsla(270, 50%, 40%, 0.12); }
	td.xl-c6 { background: hsla(50, 50%, 50%, 0.04); } th.xl-c6 { background: hsla(50, 50%, 40%, 0.12); }
	td.xl-c7 { background: hsla(190, 50%, 50%, 0.04); } th.xl-c7 { background: hsla(190, 50%, 40%, 0.12); }
</style>
<div class="xl-toolbar">
	<span class="info" id="xl-info"></span>
	<button type="button" class="primary" id="xl-edit">Edit</button>
</div>
<div class="xl-tabs">${sheetTabs}</div>
<div class="xl-notice"><span class="hint" id="xl-notice"></span></div>
<div class="xl-grid" id="xl-grid"></div>
<script>
	const SHEETS = ${escScript(sheets)};
	const FILE_NAME = ${escScript(fileName)};
	const MAX_ROWS = ${MAX_DISPLAY_ROWS};
	const MAX_COLS = ${MAX_DISPLAY_COLS};

	let active = 0;
	let sortCol = -1;
	let sortAsc = true;
	let view = [];

	function esc(value) {
		return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function plural(n, word) {
		return n.toLocaleString() + " " + word + (n === 1 ? "" : "s");
	}

	function selectSheet(index) {
		active = index;
		sortCol = -1;
		sortAsc = true;
		view = SHEETS[index].rows.slice(1);
		for (const tab of document.querySelectorAll(".xl-tab")) {
			tab.setAttribute("aria-pressed", String(Number(tab.dataset.sheet) === index));
		}
		render();
	}

	function sortByCol(col) {
		if (sortCol === col) sortAsc = !sortAsc;
		else { sortCol = col; sortAsc = true; }
		view.sort((a, b) => {
			const va = a[col] ?? "", vb = b[col] ?? "";
			const na = Number(va), nb = Number(vb);
			if (va !== "" && vb !== "" && !isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
			return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
		});
		render();
	}

	function render() {
		const sheet = SHEETS[active];
		const header = sheet.rows[0] ?? [];
		const colCount = header.length;

		document.getElementById("xl-info").textContent =
			FILE_NAME + " — " + sheet.name + ": " + plural(Math.max(sheet.totalRows - 1, 0), "row") + ", " + plural(sheet.totalCols, "col");

		const limits = [];
		if (sheet.totalRows > MAX_ROWS) limits.push("Showing " + MAX_ROWS.toLocaleString() + " of " + sheet.totalRows.toLocaleString() + " rows");
		if (sheet.totalCols > MAX_COLS) limits.push("Showing " + MAX_COLS + " of " + sheet.totalCols + " columns");
		document.getElementById("xl-notice").textContent = limits.join(" · ");

		if (colCount === 0) {
			document.getElementById("xl-grid").innerHTML = '<div class="empty-state">Empty sheet</div>';
			return;
		}

		let html = "<table><thead><tr>";
		for (let c = 0; c < colCount; c++) {
			const arrow = c === sortCol ? (sortAsc ? " ▲" : " ▼") : "";
			html += '<th class="xl-c' + (c % 8) + '" data-col="' + c + '">' + esc(header[c] ?? "") + '<span class="sort-arrow">' + arrow + "</span></th>";
		}
		html += "</tr></thead><tbody>";
		for (const row of view) {
			html += "<tr>";
			for (let c = 0; c < colCount; c++) html += '<td class="xl-c' + (c % 8) + '">' + esc(row[c] ?? "") + "</td>";
			html += "</tr>";
		}
		html += "</tbody></table>";
		document.getElementById("xl-grid").innerHTML = html;
	}

	document.getElementById("xl-edit").addEventListener("click", () => {
		window.parent.postMessage({ type: "edit" }, "*");
	});
	document.querySelector(".xl-tabs").addEventListener("click", (event) => {
		const tab = event.target.closest(".xl-tab");
		if (tab) selectSheet(Number(tab.dataset.sheet));
	});
	document.getElementById("xl-grid").addEventListener("click", (event) => {
		const th = event.target.closest("th");
		if (th) sortByCol(Number(th.dataset.col));
	});

	selectSheet(0);
</script>`;
}

function buildErrorHtml(filePath, error) {
	const message = error instanceof Error ? error.message : String(error);
	return `<div class="empty-state">
	<h2>Spreadsheet preview failed</h2>
	<p><strong>${esc(basename(filePath))}</strong></p>
	<pre style="white-space:pre-wrap;color:var(--error,#ef4444)">${esc(message)}</pre>
</div>`;
}
