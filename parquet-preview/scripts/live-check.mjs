// Use only the socket of an owned make agent-test instance.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [socket, fixtureRoot, evidence] = process.argv.slice(2);
if (!socket?.includes("/Gits/.tuic/tuic-at/") || !fixtureRoot || !evidence)
	throw new Error("Owned agent-test socket, fixture root and evidence path required");
function request(path, body) {
	return JSON.parse(
		execFileSync(
			"curl",
			[
				"--silent",
				"--show-error",
				"--fail-with-body",
				"--max-time",
				"10",
				"--unix-socket",
				socket,
				...(body ? ["-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body)] : []),
				`http://localhost${path}`,
			],
			{ encoding: "utf8" },
		),
	);
}
async function probe(input) {
	const wait = async (read) => {
		const until = Date.now() + 30000;
		while (Date.now() < until) {
			const value = read();
			if (value) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("DOM observation deadline exceeded");
	};
	const checks = [];
	try {
		await wait(() => window.__TUIC__?.plugin("parquet-preview")?.loaded);
		checks.push("real external plugin loaded");
		for (const codec of ["snappy", "gzip", "zstd"]) {
			await window.__TAURI__.event.emit("file-open", [`${input.root}/${codec}.parquet`]);
			const doc = await wait(() =>
				[...document.querySelectorAll("iframe")]
					.map((f) => f.contentDocument)
					.find((d) => d?.title === `${codec}.parquet` && d.querySelector("#rows tbody tr")),
			);
			if (!doc.querySelector("#summary").textContent.includes("205 rows"))
				throw new Error("metadata row count mismatch");
			const values = [...doc.querySelectorAll("#rows tbody tr:first-child td")].map((td) => td.textContent);
			if (values[1] !== "9007199254740993" || values[7] !== "12345678901234567890.34")
				throw new Error("numeric precision lost");
			if (doc.querySelector("#rows tbody tr:nth-child(2) td:nth-child(2)").textContent !== "NULL")
				throw new Error("null missing");
			if (!doc.querySelector("#rows tbody tr:nth-child(2) td:nth-child(2)").classList.contains("null"))
				throw new Error("null style missing");
			if (doc.querySelector("#rows script")) throw new Error("data became markup");
			doc.querySelector("#next").click();
			await wait(() => doc.querySelector("#page").textContent === "Rows 101–200 of 205");
			if (doc.querySelector("#rows tbody tr td").textContent !== "100") throw new Error("cross-group page mismatch");
			doc.querySelector("#next").click();
			await wait(() => doc.querySelector("#page").textContent === "Rows 201–205 of 205");
			if (doc.querySelectorAll("#rows tbody tr").length !== 5 || !doc.querySelector("#next").disabled)
				throw new Error("last page mismatch");
			doc.querySelector("#prev").click();
			await wait(() => doc.querySelector("#page").textContent === "Rows 101–200 of 205");
			checks.push(`${codec}: metadata, exact types, styled nulls and three pages across row groups`);
		}
		await window.__TAURI__.event.emit("file-open", [`${input.root}/corrupt.parquet`]);
		const broken = await wait(() =>
			[...document.querySelectorAll("iframe")]
				.map((f) => f.contentDocument)
				.find((d) => d?.title === "corrupt.parquet" && d.querySelector("#error")?.textContent),
		);
		const error = broken.querySelector("#error").textContent;
		if (!error.includes("Could not preview") || !error.includes("footer")) throw new Error("corruption error missing");
		checks.push("corrupt file renders explicit footer error");
		return { marker: input.marker, ok: true, checks, error };
	} catch (error) {
		return {
			marker: input.marker,
			ok: false,
			checks,
			error: String(error),
			plugin: window.__TUIC__?.plugin("parquet-preview"),
			frames: [...document.querySelectorAll("iframe")].map((f) => ({
				title: f.contentDocument?.title,
				body: f.contentDocument?.body?.innerText?.slice(0, 1000),
			})),
		};
	}
}
const marker = randomUUID();
const health = request("/health");
if (!health.ok || health.socket_path !== socket) throw new Error("Socket identity mismatch");
request("/debug/invoke_js", {
	script: `return (${probe.toString()})(${JSON.stringify({ marker, root: fixtureRoot })});`,
});
const until = Date.now() + 180000;
while (Date.now() < until) {
	for (const log of request("/logs?source=eval_js&limit=30")) {
		let result;
		try {
			result = JSON.parse(log.message.split("\n---\n").at(-1));
		} catch {
			continue;
		}
		if (result?.marker !== marker) continue;
		writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n");
		console.log(JSON.stringify(result));
		process.exit(result.ok ? 0 : 1);
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error("Desktop probe deadline exceeded");
