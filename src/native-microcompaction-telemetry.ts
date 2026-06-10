import type { NativeMicrocompactionStats } from "./native-microcompaction.ts";

// Process-local, redacted telemetry for native microcompaction. Kept separate
// from cache diagnostics on purpose: microcompaction deliberately changes the
// `messages` section, so the cache-diagnostics contract is not overloaded with a
// cause field. Only aggregate counts are stored here -- never tool-result
// content, arguments, paths, commands, or credentials.

export type NativeMicrocompactionRecord = {
  timestamp: number;
  model: string;
  stats: NativeMicrocompactionStats;
};

export type NativeMicrocompactionTotals = {
  requests: number;
  appliedRequests: number;
  compactedResults: number;
  bytesSaved: number;
  skippedIncomplete: number;
};

export type NativeMicrocompactionTelemetrySnapshot = {
  records: NativeMicrocompactionRecord[];
  totals: NativeMicrocompactionTotals;
};

const MAX_NATIVE_MICROCOMPACTION_RECORDS = 100;
const records: NativeMicrocompactionRecord[] = [];
let aggregateTotals = emptyTotals();

function emptyTotals(): NativeMicrocompactionTotals {
  return {
    requests: 0,
    appliedRequests: 0,
    compactedResults: 0,
    bytesSaved: 0,
    skippedIncomplete: 0,
  };
}

function cloneRecord(record: NativeMicrocompactionRecord): NativeMicrocompactionRecord {
  return {
    timestamp: record.timestamp,
    model: record.model,
    stats: { ...record.stats },
  };
}

export function resetNativeMicrocompactionTelemetry(): void {
  records.length = 0;
  aggregateTotals = emptyTotals();
}

export function recordNativeMicrocompaction(record: NativeMicrocompactionRecord): NativeMicrocompactionRecord {
  const sanitized = cloneRecord(record);
  records.push(sanitized);
  if (records.length > MAX_NATIVE_MICROCOMPACTION_RECORDS) records.shift();

  aggregateTotals.requests += 1;
  if (sanitized.stats.applied) aggregateTotals.appliedRequests += 1;
  aggregateTotals.compactedResults += sanitized.stats.compactedResults;
  aggregateTotals.bytesSaved += sanitized.stats.bytesSaved;
  aggregateTotals.skippedIncomplete += sanitized.stats.skippedIncomplete;

  return cloneRecord(sanitized);
}

export function getNativeMicrocompactionTelemetrySnapshot(): NativeMicrocompactionTelemetrySnapshot {
  return {
    records: records.map(cloneRecord),
    totals: { ...aggregateTotals },
  };
}

export function formatNativeMicrocompactionSummary(
  snapshot = getNativeMicrocompactionTelemetrySnapshot(),
): string {
  const totals = snapshot.totals;
  return [
    "Claude subscription microcompaction:",
    `requests=${totals.requests}`,
    `applied=${totals.appliedRequests}`,
    `compactedResults=${totals.compactedResults}`,
    `bytesSaved=${totals.bytesSaved}`,
    `skippedIncomplete=${totals.skippedIncomplete}`,
  ].join(" ");
}
