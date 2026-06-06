export type NativeToolCallFinalOutcome =
  | "empty"
  | "start-input"
  | "clean"
  | "failed-non-object"
  | "failed-unparseable";

export type NativeToolCallDiagnosticSample = {
  timestamp: number;
  model: string;
  responseId?: string;
  sessionId?: string;
  toolName: string;
  argByteLength: number;
  deltaChunkCount: number;
  topLevelKeyCount?: number;
  finalOutcome: NativeToolCallFinalOutcome;
};

export type NativeToolCallDiagnosticsSnapshot = {
  samples: NativeToolCallDiagnosticSample[];
  totals: {
    toolCalls: number;
    byOutcome: Partial<Record<NativeToolCallFinalOutcome, number>>;
    byTool: Record<string, number>;
  };
};

const MAX_TOOL_CALL_DIAGNOSTIC_SAMPLES = 100;
const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 128;
const DIAGNOSTIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const INVALID_DIAGNOSTIC_IDENTIFIER = "[invalid]";
const samples: NativeToolCallDiagnosticSample[] = [];

function sanitizeDiagnosticIdentifier(value: string): string {
  if (value.length === 0 || value.length > MAX_DIAGNOSTIC_IDENTIFIER_LENGTH) return INVALID_DIAGNOSTIC_IDENTIFIER;
  return DIAGNOSTIC_IDENTIFIER_PATTERN.test(value) ? value : INVALID_DIAGNOSTIC_IDENTIFIER;
}

function cloneSample(sample: NativeToolCallDiagnosticSample): NativeToolCallDiagnosticSample {
  return {
    timestamp: sample.timestamp,
    model: sanitizeDiagnosticIdentifier(sample.model),
    ...(sample.responseId ? { responseId: sanitizeDiagnosticIdentifier(sample.responseId) } : {}),
    ...(sample.sessionId ? { sessionId: sanitizeDiagnosticIdentifier(sample.sessionId) } : {}),
    toolName: sanitizeDiagnosticIdentifier(sample.toolName),
    argByteLength: sample.argByteLength,
    deltaChunkCount: sample.deltaChunkCount,
    ...(sample.topLevelKeyCount !== undefined ? { topLevelKeyCount: sample.topLevelKeyCount } : {}),
    finalOutcome: sample.finalOutcome,
  };
}

export function resetNativeToolCallDiagnostics(): void {
  samples.length = 0;
}

export function recordNativeToolCallDiagnosticSample(
  sample: NativeToolCallDiagnosticSample,
): NativeToolCallDiagnosticSample {
  const sanitized = cloneSample(sample);
  samples.push(sanitized);
  if (samples.length > MAX_TOOL_CALL_DIAGNOSTIC_SAMPLES) {
    samples.splice(0, samples.length - MAX_TOOL_CALL_DIAGNOSTIC_SAMPLES);
  }
  return cloneSample(sanitized);
}

export function getNativeToolCallDiagnosticsSnapshot(): NativeToolCallDiagnosticsSnapshot {
  const byOutcome: Partial<Record<NativeToolCallFinalOutcome, number>> = {};
  const byTool = new Map<string, number>();
  const clonedSamples = samples.map(cloneSample);

  for (const sample of clonedSamples) {
    byOutcome[sample.finalOutcome] = (byOutcome[sample.finalOutcome] ?? 0) + 1;
    byTool.set(sample.toolName, (byTool.get(sample.toolName) ?? 0) + 1);
  }

  return {
    samples: clonedSamples,
    totals: {
      toolCalls: clonedSamples.length,
      byOutcome,
      byTool: Object.fromEntries(byTool),
    },
  };
}

export function formatNativeToolCallDiagnosticsSummary(
  snapshot = getNativeToolCallDiagnosticsSnapshot(),
): string {
  const latest = snapshot.samples.at(-1);
  if (!latest) return "Claude subscription tool-call diagnostics: toolCalls=0";

  return [
    "Claude subscription tool-call diagnostics:",
    `toolCalls=${snapshot.totals.toolCalls}`,
    `latest=${latest.finalOutcome}`,
    `tool=${latest.toolName}`,
    `argBytes=${latest.argByteLength}`,
    `deltaChunks=${latest.deltaChunkCount}`,
  ].join(" ");
}
