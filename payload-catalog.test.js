import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCatalogue, packagePlugins, payloadDigest } from "./scripts/payload-catalog.mjs";

// Catches: publisher/host disagree on payload paths, bytes or mutable-file exclusions.
test("payload identity matches the host vector and ignores mutable data", () => {
  const root = mkdtempSync(join(tmpdir(), "tuic-payload-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "main.js"), "hello\n");
    writeFileSync(join(root, "assets/icon.bin"), Buffer.from([0, 255, 10]));
    assert.equal(payloadDigest(root), "290e5940bcaec5c7d9924b5b9ab2fefcbfe9543b517e19ca4b1d8997f63536c9");
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data/config.json"), "user settings");
    writeFileSync(join(root, "package.json"), "build inputs");
    assert.equal(payloadDigest(root), "290e5940bcaec5c7d9924b5b9ab2fefcbfe9543b517e19ca4b1d8997f63536c9");
    writeFileSync(join(root, "assets/icon.bin"), Buffer.from([0, 254, 10]));
    assert.notEqual(payloadDigest(root), "290e5940bcaec5c7d9924b5b9ab2fefcbfe9543b517e19ca4b1d8997f63536c9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Catches: release ZIP contains a different tree from the advertised content identity.
test("release packager publishes exactly the digested payload", () => {
  const root = mkdtempSync(join(tmpdir(), "tuic-package-"));
  try {
    const source = join(root, "example");
    mkdirSync(join(source, "assets"), { recursive: true });
    mkdirSync(join(source, "data"));
    writeFileSync(join(root, "registry.json"), JSON.stringify([{ id: "example", latestVersion: "1.0.0" }]));
    writeFileSync(join(source, "main.js"), "hello\n");
    writeFileSync(join(source, "assets/icon.bin"), Buffer.from([0, 255, 10]));
    writeFileSync(join(source, "data/config.json"), "not a release asset");
    assert.equal(buildCatalogue(root)[0].contentSha256, "290e5940bcaec5c7d9924b5b9ab2fefcbfe9543b517e19ca4b1d8997f63536c9");
    packagePlugins(root, join(root, "dist"));
    const zip = join(root, "dist/example.zip");
    assert.deepEqual(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n"), ["assets/icon.bin", "main.js"]);
    assert.equal(execFileSync("unzip", ["-p", zip, "main.js"], { encoding: "utf8" }), "hello\n");
    assert.deepEqual(execFileSync("unzip", ["-p", zip, "assets/icon.bin"]), Buffer.from([0, 255, 10]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Catches: committed registry identity drifts from the bytes CI will publish.
test("catalogue digests describe every shipped plugin", () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const actual = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
  assert.deepEqual(actual, buildCatalogue(root));
});
