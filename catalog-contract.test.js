import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entries = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8"));
for (const entry of entries) {
  // Catches: Browse advertises different permissions, targeting or requirements from the installed package.
  test(`catalogue advertises the shipped ${entry.id} contract`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`./${entry.id}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(entry.latestVersion, manifest.version, "version");
    assert.equal(entry.minAppVersion, manifest.minAppVersion, "minimum app version");
    for (const field of ["capabilities", "agentTypes", "binaries"]) {
      assert.deepEqual([...(entry[field] ?? [])].sort(), [...(manifest[field] ?? [])].sort(), field);
    }
  });
}
// Catches: a dashboard package is offered to an app that has no registerDashboard API.
test("dashboard catalogue minimums include the registerDashboard host API", () => {
  for (const id of ["at-capacity-retry", "cache-keepalive", "claude-wakeup", "mdkb-dashboard", "rtk-dashboard"]) {
    const entry = entries.find((candidate) => candidate.id === id);
    assert.ok(Number(entry.minAppVersion.split(".")[0]) >= 1, id);
  }
});
