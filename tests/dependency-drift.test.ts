import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackageJson = {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
};

type LockPackage = {
  version?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, LockPackage>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

function unlockedVersion(range: string | undefined): string {
  assert.ok(range, "dependency range must exist");
  return range.replace(/^[~^]/, "");
}

test("pi dev dependency lockstep protects native provider type and schema drift checks", () => {
  const pkg = readJson<PackageJson>("../package.json");
  const lock = readJson<PackageLock>("../package-lock.json");
  const packages = lock.packages ?? {};
  const rootLock = packages[""];
  const piAi = packages["node_modules/@earendil-works/pi-ai"];
  const piCodingAgent = packages["node_modules/@earendil-works/pi-coding-agent"];
  const nestedPiAi = packages["node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai"];

  assert.ok(rootLock, "package-lock must include the root package entry");
  assert.ok(piAi, "package-lock must include direct @earendil-works/pi-ai");
  assert.ok(piCodingAgent, "package-lock must include direct @earendil-works/pi-coding-agent");
  assert.ok(nestedPiAi, "package-lock must show the pi-ai copy used by pi-coding-agent");

  const rootPiAiRange = pkg.devDependencies?.["@earendil-works/pi-ai"];
  const rootPiCodingAgentRange = pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
  assert.equal(rootPiAiRange, rootPiCodingAgentRange, "Pi packages must be bumped in lockstep");
  assert.equal(rootLock.devDependencies?.["@earendil-works/pi-ai"], rootPiAiRange);
  assert.equal(rootLock.devDependencies?.["@earendil-works/pi-coding-agent"], rootPiCodingAgentRange);

  const expectedPiVersion = unlockedVersion(rootPiAiRange);
  assert.equal(piAi.version, expectedPiVersion);
  assert.equal(piCodingAgent.version, expectedPiVersion);
  assert.equal(piCodingAgent.dependencies?.["@earendil-works/pi-ai"], rootPiAiRange);
  assert.equal(nestedPiAi.version, expectedPiVersion, "nested pi-ai must not drift from direct pi-ai");
});

test("node runtime floor and typings stay aligned with Pi runtime", () => {
  const pkg = readJson<PackageJson>("../package.json");
  const lock = readJson<PackageLock>("../package-lock.json");
  const packages = lock.packages ?? {};
  const rootLock = packages[""];
  const piAi = packages["node_modules/@earendil-works/pi-ai"];
  const piCodingAgent = packages["node_modules/@earendil-works/pi-coding-agent"];
  const nodeTypes = packages["node_modules/@types/node"];

  assert.equal(pkg.engines?.node, ">=22.19.0");
  assert.equal(rootLock?.engines?.node, pkg.engines?.node);
  assert.equal(piAi?.engines?.node, ">=22.19.0");
  assert.equal(piCodingAgent?.engines?.node, ">=22.19.0");
  assert.equal(pkg.devDependencies?.["@types/node"], "~22.19.0");
  assert.match(nodeTypes?.version ?? "", /^22\.19\./, "Node typings must stay on the supported Node 22.19 floor");
});

test("verification gates document drift-sensitive change categories", () => {
  const gates = readFileSync(new URL("../docs/verification-gates.md", import.meta.url), "utf8");

  for (const expected of [
    "Tool JSON parsing / SSE",
    "Request headers/body/cache",
    "Credentials/refresh/redaction",
    "Extension registration/provider guard",
    "Dependency/model metadata",
    "npm run check",
    "No live Anthropic calls",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ]) {
    assert.ok(gates.includes(expected), `verification gates must mention ${expected}`);
  }
});
