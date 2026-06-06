export type NativeTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type NativeUsageTotals = NativeTokenUsage & {
  requests: number;
  cacheHitRatio: number;
};

export type NativeUsageRecord = {
  timestamp: number;
  model: string;
  responseModel?: string;
  responseId?: string;
  sessionId?: string;
  usage: NativeTokenUsage;
  requestFingerprint?: string;
};

export type NativeUsageTelemetrySnapshot = {
  records: NativeUsageRecord[];
  totals: NativeUsageTotals;
  byModel: Record<string, NativeUsageTotals>;
};

const MAX_NATIVE_USAGE_RECORDS = 100;
const records: NativeUsageRecord[] = [];
let aggregateTotals = emptyTotals();
const aggregateByModel = new Map<string, NativeUsageTotals>();

function emptyTotals(): NativeUsageTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cacheHitRatio: 0,
  };
}

function cacheHitRatioFor(tokens: Pick<NativeTokenUsage, "input" | "cacheRead" | "cacheWrite">): number {
  const cacheableInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return cacheableInput > 0 ? tokens.cacheRead / cacheableInput : 0;
}

function finalizeTotals(totals: NativeUsageTotals): NativeUsageTotals {
  return {
    ...totals,
    cacheHitRatio: cacheHitRatioFor(totals),
  };
}

function addUsage(totals: NativeUsageTotals, usage: NativeTokenUsage): void {
  totals.requests += 1;
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.totalTokens += usage.totalTokens;
}

function cloneUsage(usage: NativeTokenUsage): NativeTokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function cloneRecord(record: NativeUsageRecord): NativeUsageRecord {
  return {
    timestamp: record.timestamp,
    model: record.model,
    ...(record.responseModel ? { responseModel: record.responseModel } : {}),
    ...(record.responseId ? { responseId: record.responseId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    usage: cloneUsage(record.usage),
    ...(record.requestFingerprint ? { requestFingerprint: record.requestFingerprint } : {}),
  };
}

export function resetNativeUsageTelemetry(): void {
  records.length = 0;
  aggregateTotals = emptyTotals();
  aggregateByModel.clear();
}

export function recordNativeUsage(record: NativeUsageRecord): NativeUsageRecord {
  const sanitized = cloneRecord(record);
  records.push(sanitized);
  if (records.length > MAX_NATIVE_USAGE_RECORDS) records.shift();

  addUsage(aggregateTotals, sanitized.usage);
  const modelTotals = aggregateByModel.get(sanitized.model) ?? emptyTotals();
  addUsage(modelTotals, sanitized.usage);
  aggregateByModel.set(sanitized.model, modelTotals);

  return cloneRecord(sanitized);
}

export function getNativeUsageTelemetrySnapshot(): NativeUsageTelemetrySnapshot {
  return {
    records: records.map(cloneRecord),
    totals: finalizeTotals(aggregateTotals),
    byModel: Object.fromEntries(
      Array.from(aggregateByModel.entries()).map(([model, modelTotals]) => [model, finalizeTotals(modelTotals)]),
    ),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatNativeUsageSummary(snapshot = getNativeUsageTelemetrySnapshot()): string {
  const totals = snapshot.totals;
  return [
    "Claude subscription usage:",
    `requests=${totals.requests}`,
    `input=${totals.input}`,
    `output=${totals.output}`,
    `cacheRead=${totals.cacheRead}`,
    `cacheWrite=${totals.cacheWrite}`,
    `totalTokens=${totals.totalTokens}`,
    `cacheHitRatio=${formatPercent(totals.cacheHitRatio)}`,
  ].join(" ");
}
