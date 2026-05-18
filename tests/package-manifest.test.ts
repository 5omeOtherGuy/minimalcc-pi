import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("packageManifestExposesPiExtensionWithoutCredentialMaterial", () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageText = readFileSync(packageUrl, "utf8");
  const pkg = JSON.parse(packageText) as {
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
