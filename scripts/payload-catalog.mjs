import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Keep this payload contract in sync with the host's plugin_content.rs.
function excluded(name) {
  return ["data", "node_modules", "scripts", ".claude", ".git"].includes(name)
    || (name.startsWith("package") && name.endsWith(".json"));
}

export function payloadFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...payloadFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported payload entry: ${path}`);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function payloadDigest(root, files = payloadFiles(root)) {
  const hash = createHash("sha256");
  for (const path of files) {
    const fileHash = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    hash.update(path).update("\0").update(fileHash).update("\n");
  }
  return hash.digest("hex");
}

export function buildCatalogue(root) {
  return JSON.parse(readFileSync(join(root, "registry.json"), "utf8")).map((entry) => ({
    ...entry,
    contentSha256: payloadDigest(join(root, entry.id)),
  }));
}

export function packagePlugins(root, output) {
  mkdirSync(output, { recursive: true });
  for (const entry of buildCatalogue(root)) {
    const source = join(root, entry.id);
    const files = payloadFiles(source);
    const archive = resolve(output, `${entry.id}.zip`);
    rmSync(archive, { force: true });
    // Explicit file list: package exactly the tree whose digest is advertised.
    execFileSync("zip", ["-q", archive, "--", ...files], { cwd: source });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const catalogue = buildCatalogue(root);
  if (process.argv[2] === "--check") {
    const current = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(catalogue)) {
      throw new Error("Payload digests are stale; run node scripts/payload-catalog.mjs");
    }
  } else if (process.argv[2] === "--package") {
    packagePlugins(root, resolve(process.argv[3] ?? "dist"));
  } else {
    writeFileSync(join(root, "registry.json"), `${JSON.stringify(catalogue, null, 2)}\n`);
  }
}
