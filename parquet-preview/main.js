import { openParquet } from "./model.js";
import { panelHtml } from "./panel.js";

const controllers = new Set();
export default {
	id: "parquet-preview",
	onload(host) {
		if (typeof host.fileSize !== "function" || typeof host.readFileRange !== "function")
			throw new Error("Parquet Preview requires a TUICommander build with binary range reads. Update the app.");
		host.registerFilePreview({ extensions: ["parquet"], onOpen: (ctx) => openPreview(host, ctx) });
	},
	onunload() {
		for (const controller of controllers) controller.abort();
		controllers.clear();
	},
};

export function openPreview(host, ctx) {
	const path = absolutePath(ctx.fsRoot, ctx.filePath);
	const name = ctx.filePath.replaceAll("\\", "/").split("/").pop();
	const controller = new AbortController();
	controllers.add(controller);
	let reader;
	let busy = false;
	let initialized = false;
	let panel;
	const send = (data) => {
		if (!controller.signal.aborted) panel.send(data);
	};
	const fail = (error) =>
		send({
			type: "error",
			message: `Could not preview this Parquet file. ${error instanceof Error ? error.message : String(error)}`,
		});
	async function page(index) {
		if (busy || !reader) return;
		busy = true;
		try {
			send({ type: "rows", index, rows: await reader.page(index) });
		} catch (error) {
			fail(error);
		} finally {
			busy = false;
		}
	}
	panel = host.openPanel({
		id: `parquet-${encodeURIComponent(path)}`,
		title: name,
		html: panelHtml(name),
		async onMessage(message) {
			if (message?.type === "ready" && !initialized) {
				initialized = true;
				try {
					reader = await openParquet(host, path, controller.signal);
					send({ type: "schema", count: reader.count, columns: reader.columns, schema: reader.schema });
					await page(0);
				} catch (error) {
					fail(error);
				}
			} else if (message?.type === "page") await page(message.index);
		},
		onClose() {
			controller.abort();
			controllers.delete(controller);
			reader = null;
		},
	});
	return panel;
}

function absolutePath(root, path) {
	if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")) return path;
	const sep = root?.includes("\\") ? "\\" : "/";
	return root ? root.replace(/[\\/]+$/, "") + sep + path.replace(/^[\\/]+/, "") : path;
}
