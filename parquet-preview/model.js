import { parquetMetadataAsync, parquetSchema } from "./vendor/hyparquet/src/metadata.js";
import { parquetReadObjects } from "./vendor/hyparquet/src/read.js";
import { gunzipSync } from "./vendor/fflate/esm/browser.mjs";
import { decompress } from "./vendor/fzstd/esm/index.mjs";

const RANGE_BYTES = 8 * 1024 * 1024;
const MAX_SLICE_BYTES = 128 * 1024 * 1024;
export const PAGE_SIZE = 100;
function timestamp(value, digits) {
	const units = 10n ** BigInt(digits);
	const raw = BigInt(value);
	const seconds = raw >= 0n ? raw / units : (raw - units + 1n) / units;
	const fraction = (raw - seconds * units).toString().padStart(digits, "0");
	return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", `.${fraction}Z`);
}
const parsers = {
	timestampFromMicroseconds: (value) => timestamp(value, 6),
	timestampFromNanoseconds: (value) => timestamp(value, 9),
};
const compressors = { GZIP: (bytes) => gunzipSync(bytes), ZSTD: (bytes) => decompress(bytes) };

export async function openParquet(host, path, signal) {
	const byteLength = await host.fileSize(path);
	if (!Number.isSafeInteger(byteLength) || byteLength < 12) throw new Error("Invalid Parquet file size.");
	const file = {
		byteLength,
		async slice(start, end = byteLength) {
			signal?.throwIfAborted();
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > byteLength)
				throw new Error("Invalid Parquet byte range.");
			if (end - start > MAX_SLICE_BYTES)
				throw new Error("This Parquet row group is too large to preview (128 MiB range limit).");
			const bytes = new Uint8Array(end - start);
			for (let offset = start; offset < end; offset += RANGE_BYTES) {
				signal?.throwIfAborted();
				const length = Math.min(RANGE_BYTES, end - offset);
				const encoded = await host.readFileRange(path, offset, length);
				const raw = atob(encoded);
				if (raw.length !== length)
					throw new Error("The file changed or a binary read was incomplete. Reopen the preview.");
				for (let i = 0; i < raw.length; i++) bytes[offset - start + i] = raw.charCodeAt(i);
			}
			return bytes.buffer;
		},
	};
	const metadata = await parquetMetadataAsync(file, { initialFetchSize: 8 });
	const count = Number(metadata.num_rows);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("Parquet row count exceeds the supported range.");
	const tree = parquetSchema(metadata);
	const columns = tree.children.map(({ element }) => element.name);
	return {
		count,
		schema: describeSchema(tree),
		columns,
		async page(index) {
			if (!Number.isSafeInteger(index) || index < 0 || index > Math.max(0, Math.ceil(count / PAGE_SIZE) - 1))
				throw new Error("Invalid page number.");
			signal?.throwIfAborted();
			const rows = await parquetReadObjects({
				file,
				metadata,
				compressors,
				parsers,
				rowStart: index * PAGE_SIZE,
				rowEnd: Math.min(count, (index + 1) * PAGE_SIZE),
			});
			return rows.map((row) => columns.map((name) => displayValue(row[name])));
		},
	};
}

function describeSchema(tree, prefix = "", inheritedNullable = false) {
	return tree.children.flatMap((child) => {
		const element = child.element;
		const name = prefix ? `${prefix}.${element.name}` : element.name;
		const logical = element.logical_type;
		let type = logical?.type || element.converted_type || element.type || "STRUCT";
		if (type === "DECIMAL")
			type += `(${element.precision ?? logical?.precision}, ${element.scale ?? logical?.scale ?? 0})`;
		if (logical?.unit) type += ` (${logical.unit})`;
		const nullable = inheritedNullable || element.repetition_type !== "REQUIRED";
		return [{ name, type, nullable }, ...describeSchema(child, name, nullable)];
	});
}

export function displayValue(value) {
	if (value == null) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "object")
		return JSON.stringify(value, (_key, v) =>
			typeof v === "bigint" ? v.toString() : ArrayBuffer.isView(v) ? Array.from(v) : v,
		);
	return String(value);
}
