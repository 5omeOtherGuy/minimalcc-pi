import assert from "node:assert/strict";
import test from "node:test";

import type { NativeMicrocompactionStats } from "../src/native-microcompaction.ts";
import {
  formatNativeMicrocompactionSummary,
  getNativeMicrocompactionTelemetrySnapshot,
  recordNativeMicrocompaction,
  resetNativeMicrocompactionTelemetry,
} from "../src/native-microcompaction-telemetry.ts";

function stats(overrides: Partial<NativeMicrocompactionStats> = {}): NativeMicrocompactionStats {
  return { applied: true, compactedResults: 2, keptRecent: 5, bytesSaved: 4096, skippedIncomplete: 1, ...overrides };
}

test("accumulates redacted microcompaction totals by request", () => {
  resetNativeMicrocompactionTelemetry();

  recordNativeMicrocompaction({ timestamp: 1, model: "claude-sonnet-4-6", stats: stats({ applied: true, compactedResults: 2, bytesSaved: 4096, skippedIncomplete: 1 }) });
  recordNativeMicrocompaction({ timestamp: 2, model: "claude-sonnet-4-6", stats: stats({ applied: false, compactedResults: 0, bytesSaved: 0, skippedIncomplete: 0 }) });
  recordNativeMicrocompaction({ timestamp: 3, model: "claude-opus-4-7", stats: stats({ applied: true, compactedResults: 3, bytesSaved: 9000, skippedIncomplete: 2 }) });

  const totals = getNativeMicrocompactionTelemetrySnapshot().totals;
  assert.deepEqual(totals, {
    requests: 3,
    appliedRequests: 2,
    compactedResults: 5,
    bytesSaved: 13096,
    skippedIncomplete: 3,
  });
});

test("snapshot records are clones that cannot mutate stored state", () => {
  resetNativeMicrocompactionTelemetry();
  recordNativeMicrocompaction({ timestamp: 7, model: "claude-sonnet-4-6", stats: stats() });

  const snapshot = getNativeMicrocompactionTelemetrySnapshot();
  snapshot.records[0]!.stats.bytesSaved = 999999;
  snapshot.totals.requests = 999;

  const fresh = getNativeMicrocompactionTelemetrySnapshot();
  assert.equal(fresh.records[0]!.stats.bytesSaved, 4096);
  assert.equal(fresh.totals.requests, 1);
});

test("bounds retained records while preserving aggregate totals", () => {
  resetNativeMicrocompactionTelemetry();
  for (let index = 0; index < 105; index++) {
    recordNativeMicrocompaction({ timestamp: index, model: "claude-sonnet-4-6", stats: stats({ applied: true, compactedResults: 1, bytesSaved: 100, skippedIncomplete: 0 }) });
  }
  const snapshot = getNativeMicrocompactionTelemetrySnapshot();
  assert.equal(snapshot.records.length, 100);
  assert.equal(snapshot.records[0]!.timestamp, 5);
  assert.equal(snapshot.totals.requests, 105);
  assert.equal(snapshot.totals.compactedResults, 105);
  assert.equal(snapshot.totals.bytesSaved, 10500);
});

test("reset clears records and totals", () => {
  resetNativeMicrocompactionTelemetry();
  recordNativeMicrocompaction({ timestamp: 1, model: "claude-sonnet-4-6", stats: stats() });
  resetNativeMicrocompactionTelemetry();
  const snapshot = getNativeMicrocompactionTelemetrySnapshot();
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.totals.requests, 0);
  assert.equal(snapshot.totals.bytesSaved, 0);
});

test("summary is count-only: numeric fields with no free-form content", () => {
  resetNativeMicrocompactionTelemetry();
  recordNativeMicrocompaction({ timestamp: 1, model: "claude-sonnet-4-6", stats: stats({ applied: true, compactedResults: 2, bytesSaved: 4096, skippedIncomplete: 1 }) });

  const summary = formatNativeMicrocompactionSummary();
  // The entire summary must match a strict numeric-only shape: a fixed label
  // followed by `key=<integer>` pairs and nothing else. This proves no model id,
  // tool content, path, argument, or other free-form text can reach the output.
  assert.match(
    summary,
    /^Claude subscription microcompaction: requests=\d+ applied=\d+ compactedResults=\d+ bytesSaved=\d+ skippedIncomplete=\d+$/,
  );
});
