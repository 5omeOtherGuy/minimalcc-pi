import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintNativeRequestShape,
  getNativeCacheDiagnosticsSnapshot,
  recordNativeCacheDiagnosticSample,
  resetNativeCacheDiagnostics,
} from "../src/native-cache-diagnostics.ts";

const USAGE_WITH_CACHE_READ = {
  input: 20,
  output: 5,
  cacheRead: 200,
  cacheWrite: 10,
  totalTokens: 235,
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "secret project path /tmp/private-system.md" }],
    messages: [{ role: "user", content: "do not expose this prompt" }],
    tools: [{ name: "read", description: "Read files", input_schema: { type: "object" } }],
    ...overrides,
  };
}

test("fingerprints request shape consistently without exposing model-visible content", () => {
  const fingerprint = fingerprintNativeRequestShape(payload());
  const repeatedFingerprint = fingerprintNativeRequestShape(payload());
  const serialized = JSON.stringify(fingerprint);

  assert.deepEqual(repeatedFingerprint, fingerprint);
  assert.match(fingerprint.overall, /^[a-f0-9]{64}$/);
  assert.match(fingerprint.sections.system, /^[a-f0-9]{64}$/);
  assert.match(fingerprint.sections.messages, /^[a-f0-9]{64}$/);
  assert.match(fingerprint.sections.tools, /^[a-f0-9]{64}$/);
  assert.ok(!serialized.includes("secret project path"));
  assert.ok(!serialized.includes("/tmp/private-system.md"));
  assert.ok(!serialized.includes("do not expose this prompt"));
  assert.ok(!serialized.includes("Read files"));
});

test("reports cache-read drops with changed request sections", () => {
  resetNativeCacheDiagnostics();

  const first = recordNativeCacheDiagnosticSample({
    timestamp: 1,
    model: "claude-sonnet-4-6",
    sessionId: "session-a",
    fingerprint: fingerprintNativeRequestShape(payload()),
    usage: USAGE_WITH_CACHE_READ,
  });
  assert.equal(first, undefined);

  const diagnostic = recordNativeCacheDiagnosticSample({
    timestamp: 2,
    model: "claude-sonnet-4-6",
    sessionId: "session-a",
    fingerprint: fingerprintNativeRequestShape(payload({
      tools: [{ name: "bash", description: "Run commands", input_schema: { type: "object" } }],
    })),
    usage: { input: 210, output: 6, cacheRead: 5, cacheWrite: 180, totalTokens: 401 },
  });

  assert.ok(diagnostic, "cache-read drop should produce a diagnostic");
  assert.equal(diagnostic.kind, "cache-read-drop");
  assert.equal(diagnostic.previousCacheRead, 200);
  assert.equal(diagnostic.currentCacheRead, 5);
  assert.deepEqual(diagnostic.changedSections, ["tools"]);

  const snapshot = getNativeCacheDiagnosticsSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.events[0], diagnostic);
  assert.ok(!JSON.stringify(snapshot).includes("Run commands"));
});

test("keeps diagnostics read-only by leaving payload objects unchanged", () => {
  const requestPayload = payload();
  const before = JSON.stringify(requestPayload);

  fingerprintNativeRequestShape(requestPayload);
  recordNativeCacheDiagnosticSample({
    timestamp: 3,
    model: "claude-sonnet-4-6",
    fingerprint: fingerprintNativeRequestShape(requestPayload),
    usage: USAGE_WITH_CACHE_READ,
  });

  assert.equal(JSON.stringify(requestPayload), before);
});
