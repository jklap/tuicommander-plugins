export function panelHtml(name) {
	const title = String(name).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{padding:16px}.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:16px}.table-wrap{overflow:auto;max-height:65vh}th{position:sticky;top:0;background:var(--bg-secondary)}td{max-width:400px;white-space:pre-wrap;overflow-wrap:anywhere}.null{font-style:italic;color:var(--fg-muted)}#error{color:var(--error);white-space:pre-wrap}summary{cursor:pointer}#schema{margin-bottom:16px}</style></head><body>
<h1>${title}</h1><div id="summary">Reading Parquet metadata…</div>
<details open><summary>Schema</summary><table id="schema"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead><tbody></tbody></table></details>
<div class="toolbar"><button id="prev" disabled>Previous</button><span id="page"></span><button id="next" disabled>Next</button></div>
<div id="error" role="alert"></div><div class="table-wrap"><table id="rows"><thead></thead><tbody></tbody></table></div>
<script>(${panelRuntime.toString()})()</script></body></html>`;
}

function panelRuntime() {
	let index = 0;
	let count = 0;
	let busy = true;
	const el = (id) => document.getElementById(id);
	const send = (data) => window.parent.postMessage(data, "*");
	function buttons() {
		el("prev").disabled = busy || index === 0;
		el("next").disabled = busy || (index + 1) * 100 >= count;
	}
	function row(values, header = false) {
		const tr = document.createElement("tr");
		for (const value of values) {
			const cell = document.createElement(header ? "th" : "td");
			cell.textContent = value == null ? "NULL" : value;
			if (value == null) cell.className = "null";
			tr.append(cell);
		}
		return tr;
	}
	function request(next) {
		busy = true;
		buttons();
		el("error").textContent = "";
		send({ type: "page", index: next });
	}
	el("prev").onclick = () => request(index - 1);
	el("next").onclick = () => request(index + 1);
	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) return;
		if (event.data?.type !== "tuic:host-message") return;
		const data = event.data.payload;
		if (data?.type === "schema") {
			count = data.count;
			el("summary").textContent = `${count.toLocaleString()} rows · ${data.columns.length} columns · Read only`;
			el("schema")
				.querySelector("tbody")
				.replaceChildren(...data.schema.map((c) => row([c.name, c.type, c.nullable ? "Yes" : "No"])));
			el("rows").querySelector("thead").replaceChildren(row(data.columns, true));
		} else if (data?.type === "rows") {
			index = data.index;
			busy = false;
			el("rows")
				.querySelector("tbody")
				.replaceChildren(...data.rows.map((r) => row(r)));
			el("page").textContent = count
				? `Rows ${index * 100 + 1}–${Math.min(count, (index + 1) * 100)} of ${count}`
				: "No rows";
			buttons();
		} else if (data?.type === "error") {
			busy = false;
			el("error").textContent = data.message;
			buttons();
		}
	});
	send({ type: "ready" });
}
