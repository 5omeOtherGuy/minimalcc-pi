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

test("bounds retained usage records while preserving aggregate totals", () => {
  resetNativeUsageTelemetry();

  for (let index = 0; index < 105; index++) {
    recordNativeUsage({
      timestamp: index,
      model: index % 2 === 0 ? "claude-sonnet-4-6" : "claude-opus-4-7",
      responseId: `msg_usage_${index}`,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
    });
  }

  const snapshot = getNativeUsageTelemetrySnapshot();

  assert.equal(snapshot.records.length, 100);
  assert.equal(snapshot.records[0]!.timestamp, 5);
  assert.equal(snapshot.records.at(-1)!.timestamp, 104);
  assert.equal(snapshot.totals.requests, 105);
  assert.equal(snapshot.totals.input, 105);
  assert.equal(snapshot.totals.output, 210);
  assert.equal(snapshot.totals.cacheRead, 315);
  assert.equal(snapshot.totals.cacheWrite, 420);
  assert.equal(snapshot.totals.totalTokens, 1050);
  assert.equal(snapshot.byModel["claude-sonnet-4-6"]!.requests, 53);
  assert.equal(snapshot.byModel["claude-opus-4-7"]!.requests, 52);
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
