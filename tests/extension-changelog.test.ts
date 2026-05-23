import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  compareSemver,
  getExtensionChangelogForDisplay,
  parseVersionedChangelogEntries,
} from "../src/extension-changelog.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "minimalcc-changelog-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseVersionedChangelogEntries ignores Unreleased and returns version sections", () => {
  withTempDir((dir) => {
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(changelogPath, `# Changelog\n\n## [Unreleased]\n\n- Draft\n\n## [0.2.0] - 2026-05-24\n\n### Added\n\n- Startup changelog.\n\n## [0.1.0]\n\n- Initial release.\n`, "utf8");

    const entries = parseVersionedChangelogEntries(changelogPath);

    assert.deepEqual(entries.map((entry) => entry.version), ["0.2.0", "0.1.0"]);
    assert.match(entries[0].content, /Startup changelog/);
    assert.doesNotMatch(entries[0].content, /Draft/);
  });
});

test("getExtensionChangelogForDisplay records fresh installs without displaying", () => {
  withTempDir((dir) => {
    const changelogPath = join(dir, "CHANGELOG.md");
    const statePath = join(dir, "state", "changelog-state.json");
    writeFileSync(changelogPath, "## [0.1.0]\n\n- Initial release.\n", "utf8");

    const displayed = getExtensionChangelogForDisplay({
      packageName: "pi-claude-subscription",
      packageVersion: "0.1.0",
      changelogPath,
      statePath,
    });

    assert.equal(displayed, undefined);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).lastVersion, "0.1.0");
  });
});

test("getExtensionChangelogForDisplay displays entries after an update once", () => {
  withTempDir((dir) => {
    const changelogPath = join(dir, "CHANGELOG.md");
    const statePath = join(dir, "state", "changelog-state.json");
    writeFileSync(changelogPath, `## [0.2.0]\n\n### Added\n\n- Startup changelog.\n\n## [0.1.0]\n\n- Initial release.\n`, "utf8");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ lastVersion: "0.1.0" }), "utf8");

    const firstDisplay = getExtensionChangelogForDisplay({
      packageName: "pi-claude-subscription",
      packageVersion: "0.2.0",
      changelogPath,
      statePath,
    });
    const secondDisplay = getExtensionChangelogForDisplay({
      packageName: "pi-claude-subscription",
      packageVersion: "0.2.0",
      changelogPath,
      statePath,
    });

    assert.match(firstDisplay ?? "", /^Updated pi-claude-subscription to v0\.2\.0:/);
    assert.match(firstDisplay ?? "", /Startup changelog/);
    assert.doesNotMatch(firstDisplay ?? "", /Initial release/);
    assert.equal(secondDisplay, undefined);
  });
});

test("compareSemver compares major, minor, and patch components", () => {
  assert.equal(Math.sign(compareSemver("0.2.0", "0.1.9")), 1);
  assert.equal(Math.sign(compareSemver("1.0.0", "1.0.1")), -1);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});
