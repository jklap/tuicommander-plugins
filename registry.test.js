import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8"));
for (const id of ["mdkb-dashboard", "cache-keepalive"]) {
  test(`catalog version matches shipped ${id} manifest`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`./${id}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(registry.find((entry) => entry.id === id).latestVersion, manifest.version);
  });
}

// Catches: a catalog advertising older host compatibility or permissions than its payload.
test("stories ticker catalog matches its aggregate API manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("./stories-ticker/manifest.json", import.meta.url), "utf8"));
  const entry = registry.find((item) => item.id === "stories-ticker");
  assert.equal(entry.latestVersion, manifest.version);
  assert.equal(entry.minAppVersion, manifest.minAppVersion);
  assert.deepEqual(entry.capabilities, manifest.capabilities);
  assert.deepEqual(manifest.capabilities, ["stories:read", "ui:ticker"]);
});
