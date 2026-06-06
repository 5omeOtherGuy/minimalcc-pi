import { createHash, randomBytes } from "node:crypto";

import { isRecord } from "./type-guards.ts";

export type NativeCacheFingerprintSection = "model"
  | "system"
  | "messages"
  | "tools"
  | "cacheControl"
  | "bodyConfig";

export type NativeCacheRequestFingerprint = {
  overall: string;
  sections: Record<NativeCacheFingerprintSection, string>;
};

export type NativeCacheDiagnosticUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type NativeCacheDiagnosticSample = {
  timestamp: number;
  model: string;
  responseId?: string;
  sessionId?: string;
  fingerprint: NativeCacheRequestFingerprint;
  usage: NativeCacheDiagnosticUsage;
};

export type NativeCacheBreakDiagnostic = {
  kind: "cache-read-drop";
  timestamp: number;
  model: string;
  responseId?: string;
  sessionId?: string;
  previousCacheRead: number;
  currentCacheRead: number;
  previousRequestFingerprint: string;
  currentRequestFingerprint: string;
  changedSections: NativeCacheFingerprintSection[];
};

export type NativeCacheDiagnosticsSnapshot = {
  events: NativeCacheBreakDiagnostic[];
};

const MAX_NATIVE_CACHE_DIAGNOSTIC_KEYS = 100;
const MAX_NATIVE_CACHE_DIAGNOSTIC_EVENTS = 100;
const lastSamplesByKey = new Map<string, NativeCacheDiagnosticSample>();
const events: NativeCacheBreakDiagnostic[] = [];
const FINGERPRINT_SALT = randomBytes(32);

function hash(value: string): string {
  return createHash("sha256").update(FINGERPRINT_SALT).update(value).digest("hex");
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStableJsonValue);
  if (!isRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== undefined) sorted[key] = toStableJsonValue(field);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value)) ?? "undefined";
}

function sectionHash(value: unknown): string {
  return hash(stableStringify(value));
}

function collectCacheControls(value: unknown, path: string, output: Array<{ path: string; cache_control: unknown }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCacheControls(item, `${path}[${index}]`, output));
    return;
  }

  if (!isRecord(value)) return;

  if ("cache_control" in value) {
    output.push({ path, cache_control: value.cache_control });
  }

  for (const key of Object.keys(value).sort()) {
    collectCacheControls(value[key], path ? `${path}.${key}` : key, output);
  }
}

function cacheControlShape(payload: Record<string, unknown>): unknown {
  const cacheControls: Array<{ path: string; cache_control: unknown }> = [];
  collectCacheControls(payload.system, "system", cacheControls);
  collectCacheControls(payload.messages, "messages", cacheControls);
  collectCacheControls(payload.tools, "tools", cacheControls);
  return cacheControls;
}

function bodyConfigShape(payload: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === "model" || key === "system" || key === "messages" || key === "tools") continue;
    config[key] = payload[key];
  }
  return config;
}

function cloneFingerprint(fingerprint: NativeCacheRequestFingerprint): NativeCacheRequestFingerprint {
  return {
    overall: fingerprint.overall,
    sections: { ...fingerprint.sections },
  };
}

function cloneUsage(usage: NativeCacheDiagnosticUsage): NativeCacheDiagnosticUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function cloneSample(sample: NativeCacheDiagnosticSample): NativeCacheDiagnosticSample {
  return {
    timestamp: sample.timestamp,
    model: sample.model,
    ...(sample.responseId ? { responseId: sample.responseId } : {}),
    ...(sample.sessionId ? { sessionId: sample.sessionId } : {}),
    fingerprint: cloneFingerprint(sample.fingerprint),
    usage: cloneUsage(sample.usage),
  };
}

function cloneDiagnostic(diagnostic: NativeCacheBreakDiagnostic): NativeCacheBreakDiagnostic {
  return {
    kind: diagnostic.kind,
    timestamp: diagnostic.timestamp,
    model: diagnostic.model,
    ...(diagnostic.responseId ? { responseId: diagnostic.responseId } : {}),
    ...(diagnostic.sessionId ? { sessionId: diagnostic.sessionId } : {}),
    previousCacheRead: diagnostic.previousCacheRead,
    currentCacheRead: diagnostic.currentCacheRead,
    previousRequestFingerprint: diagnostic.previousRequestFingerprint,
    currentRequestFingerprint: diagnostic.currentRequestFingerprint,
    changedSections: [...diagnostic.changedSections],
  };
}

function diagnosticKey(sample: Pick<NativeCacheDiagnosticSample, "model" | "sessionId">): string {
  return sample.sessionId ? `session:${sample.sessionId}` : `model:${sample.model}`;
}

function changedSections(
  previous: NativeCacheRequestFingerprint,
  current: NativeCacheRequestFingerprint,
): NativeCacheFingerprintSection[] {
  return (Object.keys(current.sections) as NativeCacheFingerprintSection[])
    .filter((section) => previous.sections[section] !== current.sections[section]);
}

export function resetNativeCacheDiagnostics(): void {
  lastSamplesByKey.clear();
  events.length = 0;
}

export function fingerprintNativeRequestShape(payload: Record<string, unknown>): NativeCacheRequestFingerprint {
  const sections: Record<NativeCacheFingerprintSection, string> = {
    model: sectionHash(payload.model),
    system: sectionHash(payload.system),
    messages: sectionHash(payload.messages),
    tools: sectionHash(payload.tools),
    cacheControl: sectionHash(cacheControlShape(payload)),
    bodyConfig: sectionHash(bodyConfigShape(payload)),
  };

  return {
    overall: sectionHash(sections),
    sections,
  };
}

export function recordNativeCacheDiagnosticSample(
  sample: NativeCacheDiagnosticSample,
): NativeCacheBreakDiagnostic | undefined {
  const key = diagnosticKey(sample);
  const previous = lastSamplesByKey.get(key);
  const current = cloneSample(sample);
  if (lastSamplesByKey.has(key)) lastSamplesByKey.delete(key);
  lastSamplesByKey.set(key, current);
  if (lastSamplesByKey.size > MAX_NATIVE_CACHE_DIAGNOSTIC_KEYS) {
    const oldestKey = lastSamplesByKey.keys().next().value;
    if (oldestKey !== undefined) lastSamplesByKey.delete(oldestKey);
  }

  if (!previous || previous.usage.cacheRead <= 0 || current.usage.cacheRead >= previous.usage.cacheRead) {
    return undefined;
  }

  const diagnostic: NativeCacheBreakDiagnostic = {
    kind: "cache-read-drop",
    timestamp: current.timestamp,
    model: current.model,
    ...(current.responseId ? { responseId: current.responseId } : {}),
    ...(current.sessionId ? { sessionId: current.sessionId } : {}),
    previousCacheRead: previous.usage.cacheRead,
    currentCacheRead: current.usage.cacheRead,
    previousRequestFingerprint: previous.fingerprint.overall,
    currentRequestFingerprint: current.fingerprint.overall,
    changedSections: changedSections(previous.fingerprint, current.fingerprint),
  };

  events.push(diagnostic);
  if (events.length > MAX_NATIVE_CACHE_DIAGNOSTIC_EVENTS) events.shift();
  return cloneDiagnostic(diagnostic);
}

export function getNativeCacheDiagnosticsSnapshot(): NativeCacheDiagnosticsSnapshot {
  return { events: events.map(cloneDiagnostic) };
}

export function formatNativeCacheDiagnosticsSummary(
  snapshot = getNativeCacheDiagnosticsSnapshot(),
): string {
  const latest = snapshot.events.at(-1);
  if (!latest) return "Claude subscription cache diagnostics: events=0";

  return [
    "Claude subscription cache diagnostics:",
    `events=${snapshot.events.length}`,
    `latest=${latest.kind}`,
    `model=${latest.model}`,
    `previousCacheRead=${latest.previousCacheRead}`,
    `currentCacheRead=${latest.currentCacheRead}`,
    `changedSections=${latest.changedSections.join(",") || "none"}`,
  ].join(" ");
}
