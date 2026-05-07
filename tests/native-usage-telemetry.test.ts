import assert from "node:assert/strict";
import test from "node:test";

import {
  formatNativeUsageSummary,
  getNativeUsageTelemetrySnapshot,
  recordNativeUsage,
  resetNativeUsageTelemetry,
} from "../src/native-usage-telemetry.ts";

const USAGE = {
  input: 100,
  output: 7,
  cacheRead: 80,
  cacheWrite: 20,
  totalTokens: 207,
};

test("records redacted local token and cache telemetry by request and model", () => {
  resetNativeUsageTelemetry();

  recordNativeUsage({
    timestamp: 123,
    model: "claude-sonnet-4-6",
    responseModel: "claude-sonnet-4-6-20260101",
    responseId: "msg_telemetry",
    sessionId: "session-a",
    usage: USAGE,
    requestFingerprint: "request-fingerprint-only",
  });

  const snapshot = getNativeUsageTelemetrySnapshot();

  assert.deepEqual(snapshot.totals, {
    requests: 1,
    input: 100,
    output: 7,
    cacheRead: 80,
    cacheWrite: 20,
    totalTokens: 207,
    cacheHitRatio: 0.4,
  });
  assert.deepEqual(snapshot.byModel["claude-sonnet-4-6"], snapshot.totals);
  assert.deepEqual(snapshot.records, [{
    timestamp: 123,
    model: "claude-sonnet-4-6",
    responseModel: "claude-sonnet-4-6-20260101",
    responseId: "msg_telemetry",
    sessionId: "session-a",
    usage: USAGE,
    requestFingerprint: "request-fingerprint-only",
  }]);

  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("Authorization"));
  assert.ok(!serialized.includes("Bearer"));
  assert.ok(!serialized.includes("hello from a prompt"));
});

test("formats telemetry summaries without prompt or secret fields", () => {
  resetNativeUsageTelemetry();
  recordNativeUsage({
    timestamp: 123,
    model: "claude-opus-4-7",
    usage: { input: 120, output: 30, cacheRead: 180, cacheWrite: 60, totalTokens: 390 },
  });

  const summary = formatNativeUsageSummary();

  assert.match(summary, /requests=1/);
  assert.match(summary, /input=120/);
  assert.match(summary, /output=30/);
  assert.match(summary, /cacheRead=180/);
  assert.match(summary, /cacheWrite=60/);
  assert.match(summary, /cacheHitRatio=50\.00%/);
  assert.ok(!summary.includes("Authorization"));
  assert.ok(!summary.includes("Bearer"));
});
