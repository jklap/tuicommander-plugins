import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { openParquet } from "./model.js";

function diskHost(requests = []) {
	return {
		fileSize: async (path) => (await stat(path)).size,
		async readFileRange(path, offset, length) {
			requests.push({ offset, length });
			const file = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
			try {
				const bytes = Buffer.alloc(length);
				const { bytesRead } = await file.read(bytes, 0, length, offset);
				assert.equal(bytesRead, length);
				return bytes.toString("base64");
			} finally {
				await file.close();
			}
		},
	};
}
const fixture = (codec) => new URL(`./fixtures/${codec}.parquet`, import.meta.url);

// Catches: precision loss in INT64, stringifying null as empty, logical types rendered as physical bytes, and missing codec adapters.
test("common types and nulls render from real snappy, gzip and zstd files", async () => {
	for (const codec of ["snappy", "gzip", "zstd"]) {
		const reader = await openParquet(diskHost(), fixture(codec));
		assert.equal(reader.count, 205);
		assert.deepEqual(
			reader.schema.find((c) => c.name === "seq"),
			{ name: "seq", type: "INT32", nullable: false },
		);
		assert.equal(reader.schema.find((c) => c.name === "decimal").type, "DECIMAL(30, 2)");
		const rows = await reader.page(0);
		assert.deepEqual(rows[0], [
			"0",
			"9007199254740993",
			"1.25",
			"<script>&text",
			"true",
			"2024-01-02T03:04:05.000Z",
			"2024-01-02T00:00:00.000Z",
			"12345678901234567890.34",
			"[1,2]",
			'{"x":"nested"}',
		]);
		assert.deepEqual(rows[1], ["1", null, null, null, null, null, null, null, null, null]);
	}
});

// Catches: treating page offsets as row-group-local, skipping rows at a group boundary, or reading the whole file up front.
test("pages cross row groups without missing rows or eagerly reading later groups", async () => {
	const requests = [];
	const path = fixture("snappy");
	const reader = await openParquet(diskHost(requests), path);
	const first = await reader.page(0);
	assert.equal(first.length, 100);
	assert.equal(first.at(-1)[0], "99");
	const meta = JSON.parse(await readFile(new URL("./fixtures/snappy.json", import.meta.url)));
	assert.ok(!requests.some((r) => r.offset <= meta.data_offsets[3] && r.offset + r.length > meta.data_offsets[3]));
	assert.equal(requests[0].length, 8);
	const second = await reader.page(1);
	assert.equal(second[0][0], "100");
	assert.equal(second.at(-1)[0], "199");
	assert.deepEqual(
		(await reader.page(2)).map((row) => row[0]),
		["200", "201", "202", "203", "204"],
	);
});

// Catches: a corrupt footer silently producing an empty successful table.
test("corrupt Parquet footer produces an explicit error", async () => {
	await assert.rejects(
		openParquet(
			{ fileSize: async () => 12, readFileRange: async (_p, _o, n) => Buffer.alloc(n).toString("base64") },
			"corrupt.parquet",
		),
		/invalid.*footer/i,
	);
});
