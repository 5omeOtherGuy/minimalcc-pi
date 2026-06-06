import assert from "node:assert/strict";
import test from "node:test";

import {
  formatNativeToolCallDiagnosticsSummary,
  getNativeToolCallDiagnosticsSnapshot,
  recordNativeToolCallDiagnosticSample,
  resetNativeToolCallDiagnostics,
} from "../src/native-tool-call-diagnostics.ts";

test("records metadata-only tool-call diagnostics without argument contents", () => {
  resetNativeToolCallDiagnostics();

  recordNativeToolCallDiagnosticSample({
    timestamp: 123,
    model: "claude-opus-4-8",
    responseId: "msg_tool_diag",
    sessionId: "session-a",
    toolName: "bash",
    argByteLength: 76,
    deltaChunkCount: 2,
    topLevelKeyCount: 1,
    finalOutcome: "clean",
  });

  const snapshot = getNativeToolCallDiagnosticsSnapshot();

  assert.deepEqual(snapshot, {
    samples: [{
      timestamp: 123,
      model: "claude-opus-4-8",
      responseId: "msg_tool_diag",
      sessionId: "session-a",
      toolName: "bash",
      argByteLength: 76,
      deltaChunkCount: 2,
      topLevelKeyCount: 1,
      finalOutcome: "clean",
    }],
    totals: {
      toolCalls: 1,
      byOutcome: { clean: 1 },
      byTool: { bash: 1 },
    },
  });

  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("Authorization"));
  assert.ok(!serialized.includes("Bearer"));
  assert.ok(!serialized.includes("/tmp/private-file"));
  assert.ok(!serialized.includes("echo secret"));
  assert.ok(!serialized.includes("command"));
});

test("sanitizes diagnostic identifiers and avoids prototype key hazards", () => {
  resetNativeToolCallDiagnostics();

  recordNativeToolCallDiagnosticSample({
    timestamp: 1,
    model: "claude-sonnet-4-6".repeat(10),
    responseId: "msg/contains/path-like/slashes",
    sessionId: "session contains spaces",
    toolName: "__proto__",
    argByteLength: 10,
    deltaChunkCount: 1,
    finalOutcome: "clean",
  });

  const snapshot = getNativeToolCallDiagnosticsSnapshot();

  assert.deepEqual(snapshot.samples, [{
    timestamp: 1,
    model: "[invalid]",
    responseId: "[invalid]",
    sessionId: "[invalid]",
    toolName: "__proto__",
    argByteLength: 10,
    deltaChunkCount: 1,
    finalOutcome: "clean",
  }]);
  assert.equal(snapshot.totals.byTool.__proto__, 1);
});

test("bounds retained diagnostic samples", () => {
  resetNativeToolCallDiagnostics();

  for (let index = 0; index < 105; index++) {
    recordNativeToolCallDiagnosticSample({
      timestamp: index,
      model: "claude-sonnet-4-6",
      toolName: "bash",
      argByteLength: index,
      deltaChunkCount: 1,
      finalOutcome: "clean",
    });
  }

  const snapshot = getNativeToolCallDiagnosticsSnapshot();

  assert.equal(snapshot.samples.length, 100);
  assert.equal(snapshot.samples[0]!.timestamp, 5);
  assert.equal(snapshot.samples.at(-1)!.timestamp, 104);
  assert.equal(snapshot.totals.toolCalls, 100);
});

test("clones samples and formats a privacy-preserving summary", () => {
  resetNativeToolCallDiagnostics();

  const recorded = recordNativeToolCallDiagnosticSample({
    timestamp: 1,
    model: "claude-sonnet-4-6",
    toolName: "edit",
    argByteLength: 18,
    deltaChunkCount: 1,
    finalOutcome: "failed-unparseable",
  });
  recorded.toolName = "mutated";

  const snapshot = getNativeToolCallDiagnosticsSnapshot();
  snapshot.samples[0]!.toolName = "mutated-again";

  assert.equal(getNativeToolCallDiagnosticsSnapshot().samples[0]!.toolName, "edit");
  assert.equal(formatNativeToolCallDiagnosticsSummary(),
    "Claude subscription tool-call diagnostics: toolCalls=1 latest=failed-unparseable tool=edit argBytes=18 deltaChunks=1",
  );
});
