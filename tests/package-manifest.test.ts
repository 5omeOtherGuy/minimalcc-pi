import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("packageManifestExposesPiExtensionWithoutCredentialMaterial", () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageText = readFileSync(packageUrl, "utf8");
  const pkg = JSON.parse(packageText) as {
    version?: string;
    name?: string;
    description?: string;
    license?: string;
    type?: string;
    homepage?: string;
    repository?: { type?: string; url?: string };
    bugs?: { url?: string };
    pi?: { extensions?: string[] };
    keywords?: string[];
    engines?: { node?: string };
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    files?: string[];
  };

  assert.equal(pkg.name, "pi-claude-subscription");
  assert.match(pkg.description ?? "", /Pi package/);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.homepage, "https://github.com/5omeOtherGuy/minimalcc-pi#readme");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/5omeOtherGuy/minimalcc-pi.git",
  });
  assert.deepEqual(pkg.bugs, { url: "https://github.com/5omeOtherGuy/minimalcc-pi/issues" });
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
  });
  assert.deepEqual(pkg.scripts, {
    test: "node --test --import tsx \"tests/**/*.test.ts\"",
    typecheck: "tsc --noEmit",
    check: "npm test && npm run typecheck",
  });
  assert.deepEqual(pkg.files, ["extensions/", "src/", "docs/", "CHANGELOG.md", "README.md", "LICENSE"]);

  assert.deepEqual(pkg.pi?.extensions, ["./extensions/minimalcc-pi"]);
  const extensionPath = new URL(`../${pkg.pi?.extensions?.[0] ?? ""}/index.ts`, import.meta.url);
  assert.ok(existsSync(extensionPath), `extension entry must exist: ${pkg.pi?.extensions?.[0]}/index.ts`);

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

test("packageDryRunContainsOnlyPublicRuntimeAndDocumentationFiles", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  const paths = pack.files.map((file) => file.path).sort();

  for (const requiredPath of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "extensions/minimalcc-pi/index.ts",
    "src/models.ts",
    "src/native-stream-simple.ts",
    "docs/current-status.md",
  ]) {
    assert.ok(paths.includes(requiredPath), `package must include ${requiredPath}`);
  }

  for (const path of paths) {
    assert.ok(!path.startsWith("tests/"), `package must not include tests: ${path}`);
    assert.ok(!path.startsWith(".github/"), `package must not include GitHub automation: ${path}`);
    assert.ok(!path.startsWith(".git"), `package must not include git metadata: ${path}`);
    assert.ok(!path.startsWith("AGENTS.md"), `package must not include local agent instructions: ${path}`);
    assert.ok(!path.endsWith("-report.md"), `package must not include local audit reports: ${path}`);
    assert.ok(!/(^|\/)\.credentials\.json$/.test(path), `package path must not include credential files: ${path}`);
  }
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
