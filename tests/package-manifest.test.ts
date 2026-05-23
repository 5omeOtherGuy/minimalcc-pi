import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("packageManifestExposesPiExtensionWithoutCredentialMaterial", () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageText = readFileSync(packageUrl, "utf8");
  const pkg = JSON.parse(packageText) as {
    version?: string;
    pi?: { extensions?: string[] };
    keywords?: string[];
    engines?: { node?: string };
  };

  assert.ok(Array.isArray(pkg.pi?.extensions), "pi.extensions must be an array");
  assert.ok((pkg.pi?.extensions?.length ?? 0) > 0, "pi.extensions must list an extension directory");
  const extensionPath = new URL(`../${pkg.pi?.extensions?.[0] ?? ""}`, import.meta.url);
  assert.ok(existsSync(extensionPath), `extension path must exist: ${pkg.pi?.extensions?.[0]}`);

  for (const pattern of [
    /ANTHROPIC_AUTH_TOKEN/,
    /ANTHROPIC_API_KEY/,
    /Bearer\s+[^\s"]{10,}/,
    /sk-ant-/,
    /claude-code-oauth-loaded/,
  ]) {
    assert.ok(!pattern.test(packageText), `package.json must not contain credential pattern ${pattern}`);
  }

  assert.ok(pkg.keywords?.includes("pi-package"), "manifest must declare pi-package keyword");
  assert.match(pkg.engines?.node ?? "", />=22\.19\.0/, "manifest must declare Node >=22.19.0");
});

test("current package version has a versioned changelog section", () => {
  const packageText = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(packageText) as { version?: string };
  assert.match(pkg.version ?? "", /^\d+\.\d+\.\d+$/, "package version must be a release semver");

  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const versionHeader = new RegExp(`^## \\[${pkg.version}\\](?:\\s+-\\s+.*)?$`, "m");
  assert.match(
    changelog,
    versionHeader,
    "CHANGELOG.md must move release notes from Unreleased into a versioned ## [x.y.z] section matching package.json",
  );
});
