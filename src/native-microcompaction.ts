import { Buffer } from "node:buffer";

import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

import { sentToolResultIndices } from "./native-tool-sequencing.ts";

// Claude Code-style "keep-recent" microcompaction for the native Claude
// subscription provider. Old, large tool-result content is replaced in place
// with a fixed placeholder before the request is converted to the Anthropic
// payload, reclaiming request bytes while keeping the Pi session transcript
// fully intact. This is a pure, deterministic projection: it never mutates its
// input and returns the original array unchanged when nothing is compacted.

// The exact placeholder shipped by the Claude Code CLI. Matching it keeps the
// "already cleared" check idempotent across requests.
export const TOOL_RESULT_CLEARED_PLACEHOLDER = "[Old tool result content cleared]";
// Persisted-output marker the Claude Code CLI uses for content it has already
// externalized; such results are treated as already cleared and left untouched.
const PERSISTED_OUTPUT_PREFIX = "<persisted-output>";
const PLACEHOLDER_BYTES = Buffer.byteLength(TOOL_RESULT_CLEARED_PLACEHOLDER, "utf8");

export const DEFAULT_MICROCOMPACTION_KEEP_RECENT = 5;
// Conservative byte gate (~64 KiB). Roughly approximates a meaningful
// multi-thousand-token saving without driving behavior off a token estimator
// the provider does not have yet (see docs/token-efficiency-todos.md item 12).
export const DEFAULT_MICROCOMPACTION_MIN_BYTES_SAVED = 65_536;

export interface NativeMicrocompactionConfig {
  enabled: boolean;
  keepRecent: number;
  minBytesSaved: number;
}

export interface NativeMicrocompactionStats {
  applied: boolean;
  compactedResults: number;
  keptRecent: number;
  bytesSaved: number;
  skippedIncomplete: number;
}

export interface NativeMicrocompactionResult {
  messages: readonly Message[];
  stats: NativeMicrocompactionStats;
}

export function disabledMicrocompactionConfig(): NativeMicrocompactionConfig {
  return {
    enabled: false,
    keepRecent: DEFAULT_MICROCOMPACTION_KEEP_RECENT,
    minBytesSaved: DEFAULT_MICROCOMPACTION_MIN_BYTES_SAVED,
  };
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseIntEnv(value: string | undefined, fallback: number, min: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// Resolves config from the environment at call time so toggling the feature does
// not require restarting the process. Disabled unless PI_CLAUDE_MICROCOMPACT is
// truthy; this feature changes model-visible context, so it is opt-in.
export function resolveNativeMicrocompactionConfig(
  env: Record<string, string | undefined> = process.env,
): NativeMicrocompactionConfig {
  if (!parseBooleanEnv(env.PI_CLAUDE_MICROCOMPACT)) return disabledMicrocompactionConfig();
  return {
    enabled: true,
    keepRecent: parseIntEnv(env.PI_CLAUDE_MICROCOMPACT_KEEP_RECENT, DEFAULT_MICROCOMPACTION_KEEP_RECENT, 1),
    minBytesSaved: parseIntEnv(env.PI_CLAUDE_MICROCOMPACT_MIN_BYTES, DEFAULT_MICROCOMPACTION_MIN_BYTES_SAVED, 0),
  };
}

// A result is a clearing candidate only when it is text-only and not an error:
// error payloads are small and diagnostically valuable, and image content cannot
// be represented by the text placeholder.
function isClearableCandidate(message: ToolResultMessage): boolean {
  if (message.isError) return false;
  return message.content.length > 0 && message.content.every((block) => block.type === "text");
}

function combinedToolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function isAlreadyCleared(message: ToolResultMessage): boolean {
  const text = combinedToolResultText(message);
  return text === TOOL_RESULT_CLEARED_PLACEHOLDER || text.startsWith(PERSISTED_OUTPUT_PREFIX);
}

function toolResultTextBytes(message: ToolResultMessage): number {
  let bytes = 0;
  for (const block of message.content) {
    if (block.type === "text") bytes += Buffer.byteLength(block.text, "utf8");
  }
  return bytes;
}

function clearToolResult(message: ToolResultMessage): ToolResultMessage {
  // Spread preserves toolName, toolCallId, isError, timestamp, and details; only
  // the content is replaced so the Anthropic tool-result block stays well-formed.
  return {
    ...message,
    content: [{ type: "text", text: TOOL_RESULT_CLEARED_PLACEHOLDER }],
  };
}

function noopResult(messages: readonly Message[], keptRecent: number, skippedIncomplete: number): NativeMicrocompactionResult {
  return {
    messages,
    stats: { applied: false, compactedResults: 0, keptRecent, bytesSaved: 0, skippedIncomplete },
  };
}

export function projectMessagesForNativeMicrocompaction(
  messages: readonly Message[],
  config: NativeMicrocompactionConfig,
): NativeMicrocompactionResult {
  if (!config.enabled) {
    return { messages, stats: { applied: false, compactedResults: 0, keptRecent: 0, bytesSaved: 0, skippedIncomplete: 0 } };
  }

  const keepRecent = Math.max(1, Math.floor(config.keepRecent));
  const sent = sentToolResultIndices(messages);

  // Ordered indices of tool results that (a) convertMessages would actually send
  // and (b) are the clearable kind (text-only, non-error). keepRecent applies
  // only to this candidate list, mirroring the Claude Code CLI.
  const candidates: number[] = [];
  let skippedIncomplete = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    if (!sent.has(index)) {
      skippedIncomplete += 1;
      continue;
    }
    if (isClearableCandidate(message)) candidates.push(index);
  }

  const keptRecent = Math.min(candidates.length, keepRecent);
  const olderCandidates = candidates.slice(0, Math.max(0, candidates.length - keepRecent));

  const clearIndices = new Set<number>();
  let bytesSaved = 0;
  for (const index of olderCandidates) {
    const message = messages[index] as ToolResultMessage;
    if (isAlreadyCleared(message)) continue;
    const saved = toolResultTextBytes(message) - PLACEHOLDER_BYTES;
    if (saved <= 0) continue;
    bytesSaved += saved;
    clearIndices.add(index);
  }

  if (clearIndices.size === 0 || bytesSaved < config.minBytesSaved) {
    return noopResult(messages, keptRecent, skippedIncomplete);
  }

  // Structural sharing: only the cleared tool-result messages are replaced; every
  // other message keeps its original reference.
  const projected = messages.map((message, index) =>
    clearIndices.has(index) ? clearToolResult(message as ToolResultMessage) : message,
  );

  return {
    messages: projected,
    stats: {
      applied: true,
      compactedResults: clearIndices.size,
      keptRecent,
      bytesSaved,
      skippedIncomplete,
    },
  };
}
