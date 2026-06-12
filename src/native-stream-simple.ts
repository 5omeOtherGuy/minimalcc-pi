import { createHash } from "node:crypto";

import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

import {
  type AnthropicSseEvent,
  parseAnthropicSse,
  parseAnthropicSseStream,
  type ParseAnthropicSseOptions,
} from "./anthropic-sse.ts";
import { loadClaudeCodeCredentials, type LoadCredentialOptions } from "./credentials.ts";
import {
  type AnthropicCompat,
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
} from "./models.ts";
import {
  fingerprintNativeRequestShape,
  recordNativeCacheDiagnosticSample,
} from "./native-cache-diagnostics.ts";
import {
  getNativeFetchDispatcher,
  isDispatcherCompatibilityError,
  markNativeFetchDispatcherUnsupported,
} from "./native-fetch-dispatcher.ts";
import {
  type NativeMicrocompactionConfig,
  projectMessagesForNativeMicrocompaction,
  resolveNativeMicrocompactionConfig,
} from "./native-microcompaction.ts";
import { recordNativeMicrocompaction } from "./native-microcompaction-telemetry.ts";
import {
  ANTHROPIC_MESSAGES_URL,
  buildNativeMessagesRequest,
  type NativeMessagesRequest,
  type NativeMessagesRequestInput,
} from "./native-request.ts";
import { recordNativeToolCallDiagnosticSample, type NativeToolCallFinalOutcome } from "./native-tool-call-diagnostics.ts";
import { normalizeEditToolArguments } from "./edit-tool-arguments.ts";
import {
  assistantToolCallIds,
  hasCompleteImmediateToolResults,
  shouldReplayAssistantMessage,
} from "./native-tool-sequencing.ts";
import { recordNativeUsage } from "./native-usage-telemetry.ts";
import { redactSensitiveText } from "./redaction.ts";
import {
  parseFinalToolArgumentsFromJson,
  parseToolArgumentsFromJson,
} from "./tool-json-arguments.ts";
import { isRecord } from "./type-guards.ts";

export type NativeStreamRequestOptions = {
  signal?: AbortSignal;
  knownSecrets?: readonly string[];
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
  timeoutMs?: number;
  streamNoProgressTimeoutMs?: number;
};

// Default upper bound on how long an Anthropic Messages stream body may go
// without progress after response headers arrive before the request is aborted
// with a clear progress error. Anthropic emits SSE `ping` events during normal
// streaming, so 45 s gives multiple pings of headroom while still surfacing a
// stuck connection instead of leaving Pi on "Working...".
export const DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS = 45_000;

// Response-start latency is different from in-stream idleness: Anthropic cannot
// emit SSE ping events until it has sent response headers, and large cached Opus
// requests can legitimately spend longer than the stream-body idle budget before
// the first byte. Keep a bounded watchdog for dead connections, but make the
// implicit response-start budget longer than the post-start no-progress budget.
export const DEFAULT_RESPONSE_START_TIMEOUT_MS = 120_000;

export type NativeStreamRequestResult = string | AsyncIterable<AnthropicSseEvent>;

type NativeCredentialLoadOptions = Pick<LoadCredentialOptions, "forceRefresh" | "previousAccessToken">;

export type NativeStreamSimpleDependencies = {
  loadCredentials?: (options?: NativeCredentialLoadOptions) => Promise<string>;
  buildRequest?: (input: NativeMessagesRequestInput) => NativeMessagesRequest;
  streamRequest?: (
    request: NativeMessagesRequest,
    options?: NativeStreamRequestOptions,
  ) => Promise<NativeStreamRequestResult>;
  parseSse?: (sse: string, options?: ParseAnthropicSseOptions) => AnthropicSseEvent[];
  now?: () => number;
  microcompactionConfig?: () => NativeMicrocompactionConfig;
};

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type AnthropicRedactedThinkingBlock = { type: "redacted_thinking"; data: string };
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error: boolean;
};
type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicRedactedThinkingBlock | AnthropicToolResultBlock | Record<string, unknown>>;
};

type ToolJsonDiagnosticState = {
  partialJson: string;
  deltaChunkCount: number;
  toolName: string;
  startInputKeyCount: number;
  lastParsedJsonLength: number;
};

type ToolJsonState = Map<number, ToolJsonDiagnosticState>;
type NativeStreamContractState = {
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  /** Anthropic indexes of server-side fallback marker blocks (audit-only, never Pi content). */
  fallbackBlockIndexes: Set<number>;
  /** Raw Anthropic stop_reason, kept for refusal-aware error reporting. */
  rawStopReason?: string;
  /** Informational refusal policy category from stop_details (may be absent even on refusal). */
  refusalCategory?: string;
};

type NativeStreamRequestDiagnostics = {
  method?: string;
  endpoint?: string;
  anthropicVersion?: string;
  contentType?: string;
  authKind?: string;
  requestModel?: string;
  bodyBytes?: number;
  bodyShapeHash?: string;
  bodyKeys?: string[];
  bodyConfigKeys?: string[];
  maxTokens?: number;
  stream?: boolean;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  thinkingDisplay?: string;
  effort?: string;
  outputConfigKeys?: string[];
  samplingKeys?: string[];
  toolCount?: number;
  toolNames?: string[];
  toolStats?: NativeToolRequestDiagnostics[];
  toolJsonBytes?: number;
  toolSchemaBytes?: number;
  toolDescriptionBytes?: number;
  toolShapeHash?: string;
  toolPrefixCounts?: Record<string, number>;
  systemBlockCount?: number;
  systemTextBlockCount?: number;
  systemTextBytes?: number;
  messageCount?: number;
  messageBytes?: number;
  messageRoleCounts?: Record<string, number>;
  messageContentBlockCounts?: Record<string, number>;
  messageTextBytes?: number;
  messageImageBlocks?: number;
  messageToolUseBlocks?: number;
  messageToolResultBlocks?: number;
  messageThinkingBlocks?: number;
  cacheControlCount?: number;
  metadataKeys?: string[];
  anthropicBeta?: string;
  requestMarkers?: string;
  disableParallelToolUse?: boolean;
  fallbackModels?: string[];
};

type NativeToolRequestDiagnostics = {
  name: string;
  jsonBytes: number;
  descriptionBytes: number;
  schemaBytes: number;
  schemaPropertyCount?: number;
  schemaRequiredCount?: number;
  cacheControl: boolean;
  descriptionHash?: string;
  schemaHash?: string;
};

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function optionalNumberField(record: unknown, names: readonly string[]): number | undefined {
  if (!isRecord(record)) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") return value;
  }
  return undefined;
}

// Test-only instrumentation seam: counts how many text blocks pass through the
// surrogate-sanitizing regex so the convertMessages memo can be proven to skip
// already-converted history on warm turns. Not exported into runtime behavior.
let sanitizeSurrogatesCallCount = 0;

export function getSanitizeSurrogatesCallCountForTests(): number {
  return sanitizeSurrogatesCallCount;
}

export function resetSanitizeSurrogatesCallCountForTests(): void {
  sanitizeSurrogatesCallCount = 0;
}

function sanitizeSurrogates(text: string): string {
  sanitizeSurrogatesCallCount += 1;
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

// Per-message conversion memos. Pi history is append-only and prior Message
// objects keep stable identity across requests, so converting the whole history
// every turn re-runs sanitizeSurrogates over megabytes of unchanged text in long
// sessions. These WeakMaps cache the context-free conversions keyed by the Pi
// Message object (GC-friendly: entries vanish when the message is collected).
//
// Only conversions whose output is independent of conversation context are
// memoized:
//   - user messages: pure function of the message (no model, no tool-id mapper);
//   - tool-result block content: the sanitize-heavy text transform, which does
//     not depend on the mapper (the mapped tool_use_id is still resolved live so
//     the stateful id mapper stays consistent);
//   - assistant turns with NO tool calls: independent of replay/tool sequencing
//     context, but model-dependent (signed thinking replays only for the exact
//     same native model), so keyed per model.
// Assistant turns that contain tool calls are context-dependent (replay decision
// and the stateful id mapper) and are never memoized.
type ToolResultContent = AnthropicToolResultBlock["content"];
let userMessageMemo = new WeakMap<object, AnthropicMessage | undefined>();
let toolResultContentMemo = new WeakMap<object, ToolResultContent>();
let assistantNoToolCallMemo = new WeakMap<object, Map<string, AnthropicMessage | undefined>>();

export function resetConvertMessagesMemoForTests(): void {
  userMessageMemo = new WeakMap();
  toolResultContentMemo = new WeakMap();
  assistantNoToolCallMemo = new WeakMap();
}

function nativeModelMemoKey(model: Model<Api>): string {
  return `${model.provider}\u0000${model.api}\u0000${model.id}`;
}

const ANTHROPIC_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function createAnthropicToolUseIdMapper(): (id: string) => string {
  const mappedIds = new Map<string, string>();
  const usedIds = new Set<string>();

  return (id: string): string => {
    const existing = mappedIds.get(id);
    if (existing) return existing;

    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const base = ANTHROPIC_TOOL_USE_ID_PATTERN.test(sanitized) ? sanitized : `tool_${mappedIds.size}`;
    let candidate = base;
    let suffix = 1;

    while (usedIds.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }

    mappedIds.set(id, candidate);
    usedIds.add(candidate);
    return candidate;
  };
}

function textBlocksToAnthropic(content: readonly (TextContent | ImageContent)[]): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  const hasImages = content.some((block) => block.type === "image");
  if (!hasImages) {
    return content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => sanitizeSurrogates(block.text))
      .join("\n");
  }

  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: sanitizeSurrogates(block.text) };
    }
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: block.mimeType, data: block.data },
    };
  });
}

function convertUserMessage(message: Extract<Message, { role: "user" }>): AnthropicMessage | undefined {
  // User-message conversion is a pure function of the message object (no model,
  // no tool-id mapper, no surrounding context), so the result is safe to reuse
  // across turns. The cached object is never mutated downstream (consumers in
  // native-request.ts copy via spread), so returning the shared reference is
  // safe.
  if (userMessageMemo.has(message)) return userMessageMemo.get(message);
  const result = convertUserMessageUncached(message);
  userMessageMemo.set(message, result);
  return result;
}

function convertUserMessageUncached(message: Extract<Message, { role: "user" }>): AnthropicMessage | undefined {
  if (typeof message.content === "string") {
    const content = sanitizeSurrogates(message.content);
    return content.trim().length > 0 ? { role: "user", content } : undefined;
  }

  const content = textBlocksToAnthropic(message.content);
  if (Array.isArray(content) && content.length === 0) return undefined;
  if (typeof content === "string" && content.trim().length === 0) return undefined;
  return { role: "user", content };
}

function isSameNativeClaudeSubscriptionModel(message: AssistantMessage, model: Model<Api>): boolean {
  return model.provider === CLAUDE_SUBSCRIPTION_PROVIDER_ID
    && model.api === CLAUDE_SUBSCRIPTION_NATIVE_API_ID
    && message.provider === model.provider
    && message.api === model.api
    && message.model === model.id;
}

function convertAssistantMessage(
  message: AssistantMessage,
  model: Model<Api>,
  mapToolUseId: (id: string) => string,
  replayToolCalls = true,
): AnthropicMessage | undefined {
  // Assistant turns with no tool calls never touch the stateful id mapper and
  // ignore the replay decision, so their conversion depends only on the message
  // and the model (signed thinking replays only for the exact same native
  // model). Memoize those per model. Turns that contain tool calls stay on the
  // uncached path: their output depends on mapper state and replay context.
  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (hasToolCall) {
    return convertAssistantMessageUncached(message, model, mapToolUseId, replayToolCalls);
  }

  const modelKey = nativeModelMemoKey(model);
  let byModel = assistantNoToolCallMemo.get(message);
  if (byModel?.has(modelKey)) return byModel.get(modelKey);
  const result = convertAssistantMessageUncached(message, model, mapToolUseId, replayToolCalls);
  if (!byModel) {
    byModel = new Map();
    assistantNoToolCallMemo.set(message, byModel);
  }
  byModel.set(modelKey, result);
  return result;
}

function convertAssistantMessageUncached(
  message: AssistantMessage,
  model: Model<Api>,
  mapToolUseId: (id: string) => string,
  replayToolCalls = true,
): AnthropicMessage | undefined {
  const content: Array<Record<string, unknown>> = [];
  const canReplayThinking = isSameNativeClaudeSubscriptionModel(message, model);

  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      content.push({ type: "text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "thinking") {
      if (canReplayThinking && block.redacted === true && block.thinkingSignature) {
        // Redacted thinking is opaque provider continuity data. Replay it only for the
        // exact same native Claude subscription model that produced it.
        content.push({ type: "redacted_thinking", data: block.thinkingSignature });
      } else if (canReplayThinking && !block.redacted && block.thinkingSignature) {
        // Only replay fully-signed thinking blocks from the exact same native Claude
        // subscription model. Signatures are provider/model payloads, not generic Pi
        // metadata; replaying foreign signatures makes Anthropic reject the request.
        //
        // Replay the thinking text BYTE-FOR-BYTE: the signature is computed over the
        // exact original characters, so sanitizing surrogates or trim-filtering empty
        // text would mutate the block and trip Anthropic's 400 "`thinking` or
        // `redacted_thinking` blocks in the latest assistant message cannot be
        // modified". A signed block is replayed even when its visible text is empty.
        content.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.thinkingSignature,
        });
      } else if (!canReplayThinking && block.redacted !== true && block.thinking.trim().length > 0) {
        // Cross-provider/model visible reasoning can be preserved as ordinary assistant
        // text, but its signature must never be replayed as an Anthropic thinking block.
        content.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
      }
    } else if (block.type === "toolCall" && replayToolCalls) {
      content.push({
        type: "tool_use",
        id: mapToolUseId(block.id),
        name: block.name,
        input: block.arguments,
      });
    }
  }

  return content.length > 0 ? { role: "assistant", content } : undefined;
}

function convertToolResultBlock(message: ToolResultMessage, mapToolUseId: (id: string) => string): AnthropicToolResultBlock {
  // Memoize only the sanitize-heavy content transform (the dominant byte cost in
  // long sessions). The tool_use_id is still resolved live through the stateful
  // mapper on every call so the mapper's first-seen ordering and collision
  // handling stay identical to the unmemoized path. A fresh block object is
  // returned each call; the shared content is never mutated downstream.
  let content = toolResultContentMemo.get(message);
  if (!toolResultContentMemo.has(message)) {
    content = textBlocksToAnthropic(message.content);
    toolResultContentMemo.set(message, content);
  }
  return {
    type: "tool_result",
    tool_use_id: mapToolUseId(message.toolCallId),
    content: content as ToolResultContent,
    is_error: message.isError,
  };
}

export function convertMessages(messages: readonly Message[], model: Model<Api>): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];
  const mapToolUseId = createAnthropicToolUseIdMapper();
  let pendingToolResults: AnthropicToolResultBlock[] = [];
  let expectedToolResultIds: Set<string> | undefined;

  function flushToolResults(): void {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!message) continue;

    if (message.role === "toolResult") {
      if (expectedToolResultIds?.has(message.toolCallId)) {
        pendingToolResults.push(convertToolResultBlock(message, mapToolUseId));
      }
      continue;
    }

    flushToolResults();
    expectedToolResultIds = undefined;

    if (message.role === "user") {
      const convertedMessage = convertUserMessage(message);
      if (convertedMessage) converted.push(convertedMessage);
    } else if (message.role === "assistant") {
      if (!shouldReplayAssistantMessage(message)) continue;
      const toolCallIds = assistantToolCallIds(message);
      const replayToolCalls = hasCompleteImmediateToolResults(messages, messageIndex, toolCallIds);
      const convertedMessage = convertAssistantMessage(message, model, mapToolUseId, replayToolCalls);
      if (convertedMessage) converted.push(convertedMessage);
      if (replayToolCalls && toolCallIds.length > 0) expectedToolResultIds = new Set(toolCallIds);
    }
  }

  flushToolResults();
  return converted;
}

// pi-ai types `Model<Api>["compat"]` as a union that excludes our custom API's
// compat shape, so the native compat metadata is read through one typed accessor
// instead of scattered structural casts.
function nativeCompat(model: Model<Api>): AnthropicCompat | undefined {
  return model.compat as AnthropicCompat | undefined;
}

function convertTools(tools: readonly Tool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// Process-level latch: if the OAuth lane ever rejects the `fallbacks`
// parameter (beta not enabled for this account/lane), stop sending it for the
// rest of the process instead of paying a failed round trip per request.
// Mirrors the keep-alive dispatcher compatibility latch.
let serverSideFallbackUnsupported = false;

export function resetServerSideFallbackSupportForTests(): void {
  serverSideFallbackUnsupported = false;
}

function isServerSideFallbackRejectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\D)400(?:\D|$)/.test(message) && /fallback/i.test(message);
}

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32768,
};
const ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN = /\bopus-4[-.](?:7|8)(?:\b|-)/;
// Anthropic requires extended thinking budget_tokens >= 1024 and budget_tokens <
// max_tokens; payloads outside this band fail with a 400 invalid_request_error.
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

function thinkingBudget(options: SimpleStreamOptions): number {
  if (!options.reasoning) return 0;
  const customBudget = (options.thinkingBudgets as Record<string, number | undefined> | undefined)?.[options.reasoning];
  return typeof customBudget === "number"
    ? customBudget
    : DEFAULT_THINKING_BUDGETS[options.reasoning] ?? 10240;
}

function requiresAdaptiveThinking(model: Model<Api>): boolean {
  return nativeCompat(model)?.forceAdaptiveThinking === true
    || ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN.test(model.id);
}

function mapThinkingLevelToEffort(model: Model<Api>, options: SimpleStreamOptions): string {
  const mapped = options.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
  if (typeof mapped === "string") return mapped;
  switch (options.reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "high";
  }
}

// Returns a valid (max_tokens, budget_tokens) pair under Anthropic's invariants:
//   - Anthropic max_tokens covers BOTH thinking and visible output.
//   - budget_tokens must satisfy 1024 <= budget_tokens < max_tokens.
//   - max_tokens must not exceed the model's maxTokens cap.
// The caller's options.maxTokens is treated as a visible-output ask (matching
// upstream pi-ai's Anthropic provider). We expand Anthropic max_tokens to
// cover the thinking budget on top of that ask, and only reduce or omit the
// thinking budget when the model cap forces an otherwise-invalid payload.
function resolveManualThinkingPayload(
  model: Model<Api>,
  options: SimpleStreamOptions,
  requestedBudget: number,
): { maxTokens: number; budgetTokens: number } {
  const requestedOutputTokens = options.maxTokens ?? model.maxTokens;
  const clampedOutput = Math.min(requestedOutputTokens, model.maxTokens);

  if (requestedBudget <= 0) {
    return { maxTokens: clampedOutput, budgetTokens: 0 };
  }

  const adjustedMaxTokens = Math.min(clampedOutput + requestedBudget, model.maxTokens);
  if (requestedBudget < adjustedMaxTokens) {
    return { maxTokens: adjustedMaxTokens, budgetTokens: requestedBudget };
  }

  // Model cap forced max_tokens below requestedOutput + requestedBudget. Reduce
  // thinking so budget_tokens < max_tokens, preserving as much output room as
  // possible; omit thinking entirely if no valid budget fits.
  const reducedBudget = adjustedMaxTokens - clampedOutput;
  if (reducedBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS) {
    return { maxTokens: adjustedMaxTokens, budgetTokens: reducedBudget };
  }
  return { maxTokens: clampedOutput, budgetTokens: 0 };
}

function nativePayloadModelId(model: Model<Api>): string {
  const nativeModelId = nativeCompat(model)?.nativeModelId;
  return typeof nativeModelId === "string" && nativeModelId.trim().length > 0 ? nativeModelId : model.id;
}

function contextToPayload(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): Record<string, unknown> {
  const tools = convertTools(context.tools);
  const payload: Record<string, unknown> = {
    model: nativePayloadModelId(model),
    max_tokens: options.maxTokens ?? model.maxTokens,
    messages: convertMessages(context.messages, model),
    system: context.systemPrompt ?? "",
    stream: true,
  };

  if (tools) payload.tools = tools;
  if (options.metadata) payload.metadata = options.metadata;

  const thinkingEnabled = model.reasoning && !!options.reasoning;
  if (thinkingEnabled && requiresAdaptiveThinking(model)) {
    payload.thinking = { type: "adaptive", display: "summarized" };
    payload.output_config = { effort: mapThinkingLevelToEffort(model, options) };
  } else {
    const requestedBudget = model.reasoning ? thinkingBudget(options) : 0;
    const { maxTokens, budgetTokens } = resolveManualThinkingPayload(model, options, requestedBudget);
    payload.max_tokens = maxTokens;
    if (budgetTokens > 0) {
      payload.thinking = { type: "enabled", budget_tokens: budgetTokens };
    } else if (typeof options.temperature === "number" && !requiresAdaptiveThinking(model)) {
      payload.temperature = options.temperature;
    }
  }

  // Fable 5 refusal fallback: ask the API to retry a safety-classifier decline
  // on the fallback model server-side (one round trip, fallback-credit
  // repricing), instead of failing the turn and re-sending the full context.
  const refusalFallbackModel = nativeCompat(model)?.refusalFallbackModel;
  if (refusalFallbackModel && !serverSideFallbackUnsupported) {
    payload.fallbacks = [{ model: refusalFallbackModel }];
  }

  return payload;
}

function mapStopReason(stopReason: string | undefined): StopReason {
  switch (stopReason) {
    case undefined:
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

function doneReason(stopReason: StopReason): "stop" | "length" | "toolUse" {
  if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") {
    return stopReason;
  }
  return "stop";
}

function shouldApplyCumulativeUsageValue(next: number | undefined, current: number): next is number {
  if (next === undefined) return false;
  return !(next === 0 && current > 0);
}

function updateUsage(model: Model<Api>, output: AssistantMessage, usage: unknown): void {
  const input = optionalNumberField(usage, ["input_tokens"]);
  const outputTokens = optionalNumberField(usage, ["output_tokens"]);
  const cacheRead = optionalNumberField(usage, ["cache_read_input_tokens", "cache_read_tokens"]);
  const cacheWrite = optionalNumberField(usage, ["cache_creation_input_tokens", "cache_creation_tokens"]);

  if (shouldApplyCumulativeUsageValue(input, output.usage.input)) output.usage.input = input;
  if (shouldApplyCumulativeUsageValue(outputTokens, output.usage.output)) output.usage.output = outputTokens;
  if (shouldApplyCumulativeUsageValue(cacheRead, output.usage.cacheRead)) output.usage.cacheRead = cacheRead;
  if (shouldApplyCumulativeUsageValue(cacheWrite, output.usage.cacheWrite)) output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens = output.usage.input
    + output.usage.output
    + output.usage.cacheRead
    + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function setToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  block.arguments = parseToolArgumentsFromJson(partialJson);
}

// Incremental partial-argument parsing re-parses the full accumulated fragment,
// so parsing on every input_json_delta is quadratic in the final input size.
// Measured on this repair pipeline at 128-byte deltas: ~74 ms total CPU for a
// 16 KiB tool input, ~24 s for 270 KiB, ~5 min for 1 MiB — all spent blocking
// the event loop mid-stream. Below the exact-parse bound every delta still
// updates partial arguments (small inputs keep per-delta UI fidelity and the
// historical behavior); above it, re-parse only when the fragment has grown by
// the growth factor since the last parse. The geometric schedule bounds total
// incremental parse work to a constant multiple of the final fragment size.
// Final arguments at content_block_stop are always parsed exactly.
const INCREMENTAL_TOOL_JSON_EXACT_PARSE_BOUND = 16_384;
const INCREMENTAL_TOOL_JSON_REPARSE_GROWTH = 1.25;

function shouldParsePartialToolJson(state: ToolJsonDiagnosticState): boolean {
  if (state.partialJson.length <= INCREMENTAL_TOOL_JSON_EXACT_PARSE_BOUND) return true;
  return state.partialJson.length >= state.lastParsedJsonLength * INCREMENTAL_TOOL_JSON_REPARSE_GROWTH;
}

// Apply the conservative, tool-specific argument normalizer. Only Pi's built-in
// `edit` tool is reshaped (stringified `edits` array + stray annotation keys on
// edit items); every other tool's arguments pass through verbatim.
function normalizeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return name === "edit" ? normalizeEditToolArguments(args) : args;
}

function setFinalToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  if (partialJson.length === 0) return;
  block.arguments = normalizeToolArguments(block.name, parseFinalToolArgumentsFromJson(partialJson));
}

function toolCallFailureOutcome(error: unknown): Extract<NativeToolCallFinalOutcome, "failed-non-object" | "failed-unparseable"> {
  const message = error instanceof Error ? error.message : String(error);
  return /must parse to an object/i.test(message) ? "failed-non-object" : "failed-unparseable";
}

function recordToolCallDiagnostic(
  model: Model<Api>,
  output: AssistantMessage,
  sessionId: string | undefined,
  state: ToolJsonDiagnosticState,
  finalOutcome: NativeToolCallFinalOutcome,
  topLevelKeyCount?: number,
): void {
  recordNativeToolCallDiagnosticSample({
    timestamp: output.timestamp,
    model: model.id,
    ...(output.responseId ? { responseId: output.responseId } : {}),
    ...(sessionId ? { sessionId } : {}),
    toolName: state.toolName,
    argByteLength: Buffer.byteLength(state.partialJson, "utf8"),
    deltaChunkCount: state.deltaChunkCount,
    ...(topLevelKeyCount !== undefined ? { topLevelKeyCount } : {}),
    finalOutcome,
  });
}

function assertMessageInProgress(state: NativeStreamContractState): void {
  if (!state.sawMessageStart) {
    throw new Error("Anthropic stream contract violation: missing message_start.");
  }
  if (state.sawMessageStop) {
    throw new Error("Anthropic stream contract violation: content event after message_stop.");
  }
}

function applyAnthropicEvent(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  output: AssistantMessage,
  event: AnthropicSseEvent,
  contentIndexByAnthropicIndex: Map<number, number>,
  toolJsonByContentIndex: ToolJsonState,
  contractState: NativeStreamContractState,
  sessionId?: string,
): void {
  if (event.type === "messageStart") {
    if (contractState.sawMessageStart && !contractState.sawMessageStop) {
      throw new Error("Anthropic stream contract violation: duplicate message_start before message_stop.");
    }
    contractState.sawMessageStart = true;
    contractState.sawMessageStop = false;
    if (event.responseId) output.responseId = event.responseId;
    if (event.model) output.responseModel = event.model;
    // Capture input/cache usage from message_start; it is refined by message_delta later.
    if ("usage" in event) updateUsage(model, output, event.usage);
    return;
  }

  if (event.type === "textStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({ type: "text", text: event.text }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "text_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "textDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: text delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "text") throw new Error("Anthropic stream contract violation: text delta for non-text block.");
    block.text += event.text;
    stream.push({ type: "text_delta", contentIndex, delta: event.text, partial: output });
    return;
  }

  if (event.type === "thinkingStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({
      type: "thinking",
      thinking: event.thinking,
      thinkingSignature: "",
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "redactedThinkingStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({
      type: "thinking",
      thinking: "",
      thinkingSignature: event.data,
      redacted: true,
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "thinkingDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: thinking delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "thinking") throw new Error("Anthropic stream contract violation: thinking delta for non-thinking block.");
    block.thinking += event.thinking;
    stream.push({ type: "thinking_delta", contentIndex, delta: event.thinking, partial: output });
    return;
  }

  if (event.type === "signatureDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: signature delta without content block start.");
    const block = output.content[contentIndex] as ThinkingContent | undefined;
    if (block?.type !== "thinking") throw new Error("Anthropic stream contract violation: signature delta for non-thinking block.");
    block.thinkingSignature = (block.thinkingSignature ?? "") + event.signature;
    return;
  }

  if (event.type === "fallbackStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index) || contractState.fallbackBlockIndexes.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    contractState.fallbackBlockIndexes.add(event.index);

    // The marker is audit-only and never becomes Pi content, but it is also the
    // replay boundary: blocks the refused model emitted BEFORE it must be
    // omitted when this assistant turn is echoed back (thinking,
    // redacted_thinking, and tool_use pre-boundary blocks are rejected or
    // ignored by the API; text echoes normally). Clearing the signature makes
    // convertAssistantMessage skip the thinking block on replay; dropping
    // closed pre-boundary tool calls keeps Pi from executing calls the serving
    // model never made. Tool calls are only dropped when no content block is
    // open, so live contentIndex mappings never shift.
    for (const block of output.content) {
      if (block.type === "thinking") block.thinkingSignature = "";
    }
    if (contentIndexByAnthropicIndex.size === 0) {
      output.content = output.content.filter((block) => block.type !== "toolCall");
    }
    return;
  }

  if (event.type === "toolUseStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    if (event.id.trim().length === 0 || event.name.trim().length === 0) {
      throw new Error("Anthropic stream contract violation: tool_use requires non-empty id and name.");
    }
    if (!isRecord(event.input)) {
      throw new Error("Anthropic stream contract violation: tool_use input must be an object.");
    }

    const contentIndex = output.content.push({
      type: "toolCall",
      id: event.id,
      name: event.name,
      // Normalize inline (non-streamed) tool input here too: when Anthropic
      // sends the full input on tool_use start with no input_json_delta, the
      // empty-payload final-stop path leaves these arguments as the executed set.
      arguments: normalizeToolArguments(event.name, { ...event.input }),
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    toolJsonByContentIndex.set(contentIndex, {
      partialJson: "",
      deltaChunkCount: 0,
      toolName: event.name,
      startInputKeyCount: Object.keys(event.input).length,
      lastParsedJsonLength: 0,
    });
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "toolUseInputDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: tool input delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "toolCall") throw new Error("Anthropic stream contract violation: tool input delta for non-tool block.");
    const state = toolJsonByContentIndex.get(contentIndex) ?? {
      partialJson: "",
      deltaChunkCount: 0,
      toolName: block.name,
      startInputKeyCount: 0,
      lastParsedJsonLength: 0,
    };
    state.partialJson += event.partialJson;
    state.deltaChunkCount += 1;
    toolJsonByContentIndex.set(contentIndex, state);
    if (shouldParsePartialToolJson(state)) {
      state.lastParsedJsonLength = state.partialJson.length;
      setToolArgumentsFromJson(block, state.partialJson);
    }
    stream.push({ type: "toolcall_delta", contentIndex, delta: event.partialJson, partial: output });
    return;
  }

  if (event.type === "contentBlockStop") {
    assertMessageInProgress(contractState);
    if (contractState.fallbackBlockIndexes.has(event.index)) {
      contractState.fallbackBlockIndexes.delete(event.index);
      return;
    }
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: content block stop without content block start.");
    const block = output.content[contentIndex];
    contentIndexByAnthropicIndex.delete(event.index);

    if (block?.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block?.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
    } else if (block?.type === "toolCall") {
      const state = toolJsonByContentIndex.get(contentIndex) ?? {
        partialJson: "",
        deltaChunkCount: 0,
        toolName: block.name,
        startInputKeyCount: Object.keys(block.arguments).length,
        lastParsedJsonLength: 0,
      };
      try {
        setFinalToolArgumentsFromJson(block, state.partialJson);
      } catch (error) {
        recordToolCallDiagnostic(model, output, sessionId, state, toolCallFailureOutcome(error));
        toolJsonByContentIndex.delete(contentIndex);
        throw error;
      }
      const finalOutcome: NativeToolCallFinalOutcome = state.partialJson.length > 0
        ? "clean"
        : state.startInputKeyCount > 0
          ? "start-input"
          : "empty";
      recordToolCallDiagnostic(model, output, sessionId, state, finalOutcome, Object.keys(block.arguments).length);
      toolJsonByContentIndex.delete(contentIndex);
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    } else {
      throw new Error("Anthropic stream contract violation: content block stop for unknown block.");
    }
    return;
  }

  if (event.type === "messageDelta") {
    if (!contractState.sawMessageStart) {
      throw new Error("Anthropic stream contract violation: missing message_start.");
    }
    if (event.stopReason) contractState.rawStopReason = event.stopReason;
    if (event.stopDetailsCategory) contractState.refusalCategory = event.stopDetailsCategory;
    output.stopReason = mapStopReason(event.stopReason);
    if ("usage" in event) updateUsage(model, output, event.usage);
    return;
  }

  if (event.type === "messageStop") {
    if (!contractState.sawMessageStart) {
      throw new Error("Anthropic stream contract violation: missing message_start.");
    }
    if (contentIndexByAnthropicIndex.size > 0) {
      throw new Error("Anthropic stream contract violation: missing content block stop before message_stop.");
    }
    contractState.sawMessageStop = true;
    if (event.stopReason) contractState.rawStopReason = event.stopReason;
    output.stopReason = mapStopReason(event.stopReason) === "stop" && output.stopReason !== "stop"
      ? output.stopReason
      : mapStopReason(event.stopReason);
    return;
  }

  if (event.type === "contractViolation") {
    throw new Error(event.message);
  }
}

function safeStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeBooleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function jsonByteLength(value: unknown): number {
  return utf8ByteLength(jsonText(value));
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

function shortStableHash(value: unknown): string {
  return createHash("sha256").update(jsonText(toStableJsonValue(value))).digest("hex").slice(0, 16);
}

function diagnosticToken(value: string, maxLength = 96): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:@/-]+/g, "_");
  const token = /[A-Za-z0-9]/.test(sanitized) ? sanitized : "unknown";
  return token.length > maxLength ? `${token.slice(0, maxLength)}…` : token;
}

function sortedRecordKeys(value: unknown): string[] | undefined {
  return isRecord(value) ? Object.keys(value).sort() : undefined;
}

function countTextBytes(value: unknown): number {
  if (typeof value === "string") return utf8ByteLength(value);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTextBytes(item), 0);
  if (!isRecord(value)) return 0;
  const ownText = typeof value.text === "string" ? utf8ByteLength(value.text) : 0;
  return ownText + Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === "text" ? 0 : countTextBytes(child)),
    0,
  );
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheControls(item), 0);
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === "cache_control" ? 1 : 0) + countCacheControls(child),
    0,
  );
}

function systemBlockCount(system: unknown): number | undefined {
  if (Array.isArray(system)) return system.length;
  if (typeof system === "string" && system.length > 0) return 1;
  return undefined;
}

function messageCount(messages: unknown): number | undefined {
  return Array.isArray(messages) ? messages.length : undefined;
}

function incrementCount(counts: Record<string, number>, rawKey: unknown): void {
  const key = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : "unknown";
  counts[key] = (counts[key] ?? 0) + 1;
}

function countSystemTextBlocks(system: unknown): number | undefined {
  if (typeof system === "string") return system.length > 0 ? 1 : 0;
  if (!Array.isArray(system)) return undefined;
  return system.reduce((count, block) => count + (isRecord(block) && block.type === "text" ? 1 : 0), 0);
}

type NativeMessageShapeDiagnostics = {
  roleCounts: Record<string, number>;
  contentBlockCounts: Record<string, number>;
  textBytes: number;
  imageBlocks: number;
  toolUseBlocks: number;
  toolResultBlocks: number;
  thinkingBlocks: number;
};

function addMessageContentDiagnostics(content: unknown, diagnostics: NativeMessageShapeDiagnostics): void {
  if (typeof content === "string") {
    incrementCount(diagnostics.contentBlockCounts, "string");
    diagnostics.textBytes += utf8ByteLength(content);
    return;
  }

  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block)) {
      incrementCount(diagnostics.contentBlockCounts, "unknown");
      continue;
    }
    const type = typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";
    incrementCount(diagnostics.contentBlockCounts, type);
    if (typeof block.text === "string") diagnostics.textBytes += utf8ByteLength(block.text);
    if (type === "image") diagnostics.imageBlocks += 1;
    if (type === "tool_use") diagnostics.toolUseBlocks += 1;
    if (type === "tool_result") diagnostics.toolResultBlocks += 1;
    if (type === "thinking" || type === "redacted_thinking") diagnostics.thinkingBlocks += 1;
  }
}

function messageShapeDiagnostics(messages: unknown): NativeMessageShapeDiagnostics | undefined {
  if (!Array.isArray(messages)) return undefined;
  const diagnostics: NativeMessageShapeDiagnostics = {
    roleCounts: {},
    contentBlockCounts: {},
    textBytes: 0,
    imageBlocks: 0,
    toolUseBlocks: 0,
    toolResultBlocks: 0,
    thinkingBlocks: 0,
  };

  for (const message of messages) {
    if (!isRecord(message)) {
      incrementCount(diagnostics.roleCounts, "unknown");
      continue;
    }
    incrementCount(diagnostics.roleCounts, message.role);
    addMessageContentDiagnostics(message.content, diagnostics);
  }

  return diagnostics;
}

function bodyConfigKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body)
    .filter((key) => key !== "model" && key !== "system" && key !== "messages" && key !== "tools")
    .sort();
}

function samplingKeys(body: Record<string, unknown>): string[] | undefined {
  const keys = ["temperature", "top_k", "top_p"].filter((key) => body[key] !== undefined);
  return keys.length > 0 ? keys : undefined;
}

function schemaPropertyCount(schema: unknown): number | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  return Object.keys(schema.properties).length;
}

function schemaRequiredCount(schema: unknown): number | undefined {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return undefined;
  return schema.required.length;
}

function toolDiagnostics(tool: unknown): NativeToolRequestDiagnostics | undefined {
  if (!isRecord(tool)) return undefined;
  const name = safeStringField(tool.name);
  if (!name) return undefined;
  const description = typeof tool.description === "string" ? tool.description : "";
  const inputSchema = tool.input_schema;

  return {
    name,
    jsonBytes: jsonByteLength(tool),
    descriptionBytes: utf8ByteLength(description),
    schemaBytes: inputSchema === undefined ? 0 : jsonByteLength(inputSchema),
    ...(schemaPropertyCount(inputSchema) !== undefined ? { schemaPropertyCount: schemaPropertyCount(inputSchema) } : {}),
    ...(schemaRequiredCount(inputSchema) !== undefined ? { schemaRequiredCount: schemaRequiredCount(inputSchema) } : {}),
    cacheControl: "cache_control" in tool,
    ...(description.length > 0 ? { descriptionHash: shortStableHash(description) } : {}),
    ...(inputSchema !== undefined ? { schemaHash: shortStableHash(inputSchema) } : {}),
  };
}

function toolsDiagnostics(tools: unknown): NativeToolRequestDiagnostics[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(toolDiagnostics).filter((entry): entry is NativeToolRequestDiagnostics => entry !== undefined);
}

function toolPrefixCounts(toolNames: readonly string[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const name of toolNames) {
    for (const prefix of ["mcp_", "sa__"] as const) {
      if (name.startsWith(prefix)) counts[prefix] = (counts[prefix] ?? 0) + 1;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function safeShapeForBodyHash(body: Record<string, unknown>, toolStats: readonly NativeToolRequestDiagnostics[] | undefined): Record<string, unknown> {
  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
  const messageShape = messageShapeDiagnostics(body.messages);
  return {
    model: safeStringField(body.model),
    max_tokens: safeNumberField(body.max_tokens),
    stream: safeBooleanField(body.stream),
    body_config_keys: bodyConfigKeys(body),
    thinking: thinking ? {
      type: safeStringField(thinking.type),
      budget_tokens: safeNumberField(thinking.budget_tokens),
      display: safeStringField(thinking.display),
    } : undefined,
    output_config: outputConfig ? sortedRecordKeys(outputConfig) : undefined,
    sampling_keys: samplingKeys(body),
    system_blocks: systemBlockCount(body.system),
    system_text_blocks: countSystemTextBlocks(body.system),
    system_text_bytes: countTextBytes(body.system),
    messages: messageCount(body.messages),
    message_bytes: body.messages === undefined ? undefined : jsonByteLength(body.messages),
    message_roles: messageShape?.roleCounts,
    message_content_blocks: messageShape?.contentBlockCounts,
    message_text_bytes: messageShape?.textBytes,
    message_image_blocks: messageShape?.imageBlocks,
    message_tool_use_blocks: messageShape?.toolUseBlocks,
    message_tool_result_blocks: messageShape?.toolResultBlocks,
    message_thinking_blocks: messageShape?.thinkingBlocks,
    tool_stats: toolStats?.map((tool) => ({
      name: tool.name,
      json_bytes: tool.jsonBytes,
      description_bytes: tool.descriptionBytes,
      schema_bytes: tool.schemaBytes,
      schema_properties: tool.schemaPropertyCount,
      schema_required: tool.schemaRequiredCount,
      cache_control: tool.cacheControl,
      description_hash: tool.descriptionHash,
      schema_hash: tool.schemaHash,
    })),
    metadata_keys: sortedRecordKeys(body.metadata),
    cache_controls: countCacheControls(body),
  };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const matched = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return matched?.[1];
}

function requestMarkerSummary(request: NativeMessagesRequest, body: Record<string, unknown>): string {
  const userAgent = headerValue(request.headers, "user-agent");
  const hasMetadataUserId = isRecord(body.metadata) && typeof body.metadata.user_id === "string";
  const systemBlocks = Array.isArray(body.system) ? body.system : [body.system];
  const hasBillingHeader = systemBlocks.some((block) => isRecord(block)
    && typeof block.text === "string"
    && block.text.startsWith("x-anthropic-billing-header:"));

  return [
    `x_app=${headerValue(request.headers, "x-app") ? 1 : 0}`,
    `ua_claude_cli=${userAgent?.includes("claude-cli/") ? 1 : 0}`,
    `cc_session=${headerValue(request.headers, "x-claude-code-session-id") ? 1 : 0}`,
    `client_request_id=${headerValue(request.headers, "x-client-request-id") ? 1 : 0}`,
    `billing_header=${hasBillingHeader ? 1 : 0}`,
    `metadata_user_id=${hasMetadataUserId ? 1 : 0}`,
  ].join(",");
}

function requestDiagnosticsFromBody(body: Record<string, unknown>): NativeStreamRequestDiagnostics {
  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
  const toolChoice = isRecord(body.tool_choice) ? body.tool_choice : undefined;
  const disableParallelToolUse = typeof toolChoice?.disable_parallel_tool_use === "boolean"
    ? toolChoice.disable_parallel_tool_use
    : undefined;

  const fallbackModels = Array.isArray(body.fallbacks)
    ? body.fallbacks
      .map((entry) => (isRecord(entry) ? safeStringField(entry.model) : undefined))
      .filter((entry): entry is string => entry !== undefined)
    : undefined;
  const toolStats = toolsDiagnostics(body.tools);
  const toolNames = toolStats?.map((tool) => tool.name);
  const configKeys = bodyConfigKeys(body);
  const sampleKeys = samplingKeys(body);
  const messageShape = messageShapeDiagnostics(body.messages);
  const safeBodyShape = safeShapeForBodyHash(body, toolStats);

  return {
    requestModel: safeStringField(body.model),
    bodyBytes: jsonByteLength(body),
    bodyShapeHash: shortStableHash(safeBodyShape),
    bodyKeys: Object.keys(body).sort(),
    ...(configKeys.length > 0 ? { bodyConfigKeys: configKeys } : {}),
    maxTokens: safeNumberField(body.max_tokens),
    stream: safeBooleanField(body.stream),
    thinkingType: thinking ? safeStringField(thinking.type) : undefined,
    thinkingBudgetTokens: thinking ? safeNumberField(thinking.budget_tokens) : undefined,
    thinkingDisplay: thinking ? safeStringField(thinking.display) : undefined,
    effort: outputConfig ? safeStringField(outputConfig.effort) : undefined,
    ...(outputConfig ? { outputConfigKeys: sortedRecordKeys(outputConfig) } : {}),
    ...(sampleKeys ? { samplingKeys: sampleKeys } : {}),
    toolCount: Array.isArray(body.tools) ? body.tools.length : undefined,
    ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
    ...(toolStats && toolStats.length > 0 ? {
      toolStats,
      toolJsonBytes: toolStats.reduce((sum, tool) => sum + tool.jsonBytes, 0),
      toolSchemaBytes: toolStats.reduce((sum, tool) => sum + tool.schemaBytes, 0),
      toolDescriptionBytes: toolStats.reduce((sum, tool) => sum + tool.descriptionBytes, 0),
      toolShapeHash: shortStableHash(toolStats.map((tool) => ({
        name: tool.name,
        jsonBytes: tool.jsonBytes,
        descriptionBytes: tool.descriptionBytes,
        schemaBytes: tool.schemaBytes,
        schemaPropertyCount: tool.schemaPropertyCount,
        schemaRequiredCount: tool.schemaRequiredCount,
        cacheControl: tool.cacheControl,
        descriptionHash: tool.descriptionHash,
        schemaHash: tool.schemaHash,
      }))),
    } : {}),
    ...(toolNames ? { toolPrefixCounts: toolPrefixCounts(toolNames) } : {}),
    ...(systemBlockCount(body.system) !== undefined ? { systemBlockCount: systemBlockCount(body.system) } : {}),
    ...(countSystemTextBlocks(body.system) !== undefined ? { systemTextBlockCount: countSystemTextBlocks(body.system) } : {}),
    systemTextBytes: countTextBytes(body.system),
    ...(messageCount(body.messages) !== undefined ? { messageCount: messageCount(body.messages) } : {}),
    ...(body.messages !== undefined ? { messageBytes: jsonByteLength(body.messages) } : {}),
    ...(messageShape ? {
      messageRoleCounts: messageShape.roleCounts,
      messageContentBlockCounts: messageShape.contentBlockCounts,
      messageTextBytes: messageShape.textBytes,
      messageImageBlocks: messageShape.imageBlocks,
      messageToolUseBlocks: messageShape.toolUseBlocks,
      messageToolResultBlocks: messageShape.toolResultBlocks,
      messageThinkingBlocks: messageShape.thinkingBlocks,
    } : {}),
    cacheControlCount: countCacheControls(body),
    ...(sortedRecordKeys(body.metadata) ? { metadataKeys: sortedRecordKeys(body.metadata) } : {}),
    ...(disableParallelToolUse !== undefined ? { disableParallelToolUse } : {}),
    ...(fallbackModels && fallbackModels.length > 0 ? { fallbackModels } : {}),
  };
}

function requestDiagnosticsFromRequest(request: NativeMessagesRequest): NativeStreamRequestDiagnostics {
  return {
    ...requestDiagnosticsFromBody(request.body),
    method: request.method,
    endpoint: new URL(request.url).pathname,
    anthropicVersion: headerValue(request.headers, "anthropic-version"),
    contentType: headerValue(request.headers, "content-type"),
    authKind: headerValue(request.headers, "authorization") ? "oauth_bearer" : "none",
    anthropicBeta: headerValue(request.headers, "anthropic-beta"),
    requestMarkers: requestMarkerSummary(request, request.body),
  };
}

function formatStringList(values: readonly string[] | undefined, maxItems = 64): string | undefined {
  if (!values || values.length === 0) return undefined;
  const visible = values.slice(0, maxItems).map((value) => diagnosticToken(value));
  const suffix = values.length > maxItems ? `|…+${values.length - maxItems}` : "";
  return `${visible.join("|")}${suffix}`;
}

function formatToolStats(toolStats: readonly NativeToolRequestDiagnostics[] | undefined): string | undefined {
  if (!toolStats || toolStats.length === 0) return undefined;
  return toolStats.map((tool) => [
    diagnosticToken(tool.name),
    `bytes=${tool.jsonBytes}`,
    `schema=${tool.schemaBytes}`,
    `desc=${tool.descriptionBytes}`,
    tool.schemaPropertyCount !== undefined ? `props=${tool.schemaPropertyCount}` : undefined,
    tool.schemaRequiredCount !== undefined ? `required=${tool.schemaRequiredCount}` : undefined,
    `cache=${tool.cacheControl ? 1 : 0}`,
    tool.schemaHash ? `schema_hash=${tool.schemaHash}` : undefined,
    tool.descriptionHash ? `desc_hash=${tool.descriptionHash}` : undefined,
  ].filter(Boolean).join(":")).join("|");
}

function formatPrefixCounts(counts: Record<string, number> | undefined): string | undefined {
  if (!counts) return undefined;
  const parts = Object.keys(counts).sort().map((prefix) => `${diagnosticToken(prefix)}=${counts[prefix]}`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

function formatCounts(counts: Record<string, number> | undefined): string | undefined {
  if (!counts) return undefined;
  const parts = Object.keys(counts).sort().map((key) => `${diagnosticToken(key)}=${counts[key]}`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

function anthropicErrorTypeFromMessage(message: string): string | undefined {
  const match = /"error"\s*:\s*\{[^{}]*"type"\s*:\s*"([^"]+)"/.exec(message);
  return match?.[1] ? diagnosticToken(match[1]) : undefined;
}

const RESPONSE_DIAGNOSTIC_HEADER_PATTERNS = [
  /^anthropic-ratelimit-/i,
  /^retry-after$/i,
  /^content-type$/i,
] as const;

function responseHeaderDiagnosticParts(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => RESPONSE_DIAGNOSTIC_HEADER_PATTERNS.some((pattern) => pattern.test(name)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `response_${diagnosticToken(name.toLowerCase(), 120)}=${diagnosticToken(value, 160)}`);
}

function activeToolDiagnosticParts(toolJsonByContentIndex: ToolJsonState): string[] {
  const activeTools = [...toolJsonByContentIndex.entries()];
  if (activeTools.length === 0) return [];

  if (activeTools.length === 1) {
    const [, state] = activeTools[0];
    return [
      `open_tool=${state.toolName}`,
      `tool_json_bytes=${Buffer.byteLength(state.partialJson, "utf8")}`,
      `tool_json_deltas=${state.deltaChunkCount}`,
      `tool_start_keys=${state.startInputKeyCount}`,
    ];
  }

  const totalBytes = activeTools.reduce(
    (sum, [, state]) => sum + Buffer.byteLength(state.partialJson, "utf8"),
    0,
  );
  const totalDeltas = activeTools.reduce((sum, [, state]) => sum + state.deltaChunkCount, 0);
  return [
    `open_tools=${activeTools.length}`,
    `tool_json_bytes=${totalBytes}`,
    `tool_json_deltas=${totalDeltas}`,
  ];
}

function errorCauseMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const cause = error.cause;
  if (cause === undefined) return undefined;

  if (cause instanceof Error) {
    const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
    return [code, cause.message].filter(Boolean).join(": ");
  }

  if (isRecord(cause)) {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const message = typeof cause.message === "string" ? cause.message : undefined;
    const text = [code, message].filter(Boolean).join(": ");
    return text.length > 0 ? text : undefined;
  }

  return String(cause);
}

function errorMessageFrom(error: unknown, knownSecrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = errorCauseMessage(error);
  return redactSensitiveText(
    causeMessage && !message.includes(causeMessage) ? `${message}; cause: ${causeMessage}` : message,
    knownSecrets,
  );
}

function accessTokenSecrets(accessToken: string): string[] {
  return [accessToken, `Bearer ${accessToken}`];
}

function appendUniqueSecrets(secrets: readonly string[], additions: readonly string[]): string[] {
  const next = [...secrets];
  for (const addition of additions) {
    if (!next.includes(addition)) next.push(addition);
  }
  return next;
}

function isRefreshableAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bauthentication_error\b/i.test(message)) return true;

  if (isRecord(error)) {
    if (error.status === 401) return true;
    if (typeof error.type === "string" && /\bauthentication_error\b/i.test(error.type)) return true;
  }

  return /(?:^|\D)401(?:\D|$)/.test(message);
}

function assertClaudeSubscriptionProvider(model: Model<Api>): void {
  if (model.provider === CLAUDE_SUBSCRIPTION_PROVIDER_ID) return;

  throw new Error(
    `Native Claude subscription stream refused provider '${model.provider}'. `
      + `Use provider '${CLAUDE_SUBSCRIPTION_PROVIDER_ID}'.`,
  );
}

function combineStreamAbortSignals(
  signal: AbortSignal | undefined,
  options: NativeStreamRequestOptions,
  behavior: { includeTotalTimeout?: boolean } = {},
): { signal?: AbortSignal; responseStarted: () => void; cleanup: () => void } {
  const totalTimeoutMs = behavior.includeTotalTimeout === false ? undefined : options.timeoutMs;
  const responseStartTimeoutMs = options.streamNoProgressTimeoutMs
    ?? options.timeoutMs
    ?? DEFAULT_RESPONSE_START_TIMEOUT_MS;
  const needsController = signal
    || (typeof totalTimeoutMs === "number" && totalTimeoutMs > 0)
    || (typeof responseStartTimeoutMs === "number" && responseStartTimeoutMs > 0);
  if (!needsController) {
    return { signal: undefined, responseStarted: () => {}, cleanup: () => {} };
  }

  const controller = new AbortController();
  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  let responseStartTimeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromInput = () => controller.abort(signal?.reason);

  if (signal?.aborted) abortFromInput();
  signal?.addEventListener("abort", abortFromInput, { once: true });

  if (typeof totalTimeoutMs === "number" && totalTimeoutMs > 0) {
    totalTimeout = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${totalTimeoutMs}ms`)),
      totalTimeoutMs,
    );
  }
  if (typeof responseStartTimeoutMs === "number" && responseStartTimeoutMs > 0) {
    responseStartTimeout = setTimeout(
      () => controller.abort(new Error(`Anthropic Messages API stream made no progress for ${responseStartTimeoutMs}ms before response started`)),
      responseStartTimeoutMs,
    );
  }

  const clearResponseStartTimeout = () => {
    if (responseStartTimeout) clearTimeout(responseStartTimeout);
    responseStartTimeout = undefined;
  };

  return {
    signal: controller.signal,
    responseStarted: clearResponseStartTimeout,
    cleanup: () => {
      if (totalTimeout) clearTimeout(totalTimeout);
      clearResponseStartTimeout();
      signal?.removeEventListener("abort", abortFromInput);
    },
  };
}

async function fetchNativeMessagesResponse(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions,
  behavior: { includeTotalTimeout?: boolean } = {},
): Promise<{ response: Response; cleanup: () => void }> {
  // Defense-in-depth: refuse to send the OAuth Bearer token anywhere except
  // the canonical Anthropic Messages endpoint. The URL is built from the
  // hardcoded ANTHROPIC_MESSAGES_URL constant in src/native-request.ts; this
  // invariant fails closed if any future change introduces a configurable or
  // caller-supplied URL on this code path.
  if (request.url !== ANTHROPIC_MESSAGES_URL) {
    throw new Error(
      `Anthropic Messages API stream refused outbound URL: only ${ANTHROPIC_MESSAGES_URL} is allowed.`,
    );
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Anthropic Messages API fetch implementation is unavailable");
  }

  const { signal, responseStarted, cleanup } = combineStreamAbortSignals(options.signal, options, behavior);
  const fetchInit: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  };
  try {
    const response = await fetchWithNativeKeepAlive(request.url, fetchInit);
    responseStarted();
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(
      `Anthropic Messages API stream transport error: ${errorMessageFrom(error, options.knownSecrets ?? [])}`,
    );
  }
}

// `dispatcher` is an undici extension of RequestInit, not part of the standard
// fetch types.
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

// Sends the request through a keep-alive dispatcher (see
// src/native-fetch-dispatcher.ts) so back-to-back Anthropic requests reuse the
// pooled TLS connection across the multi-second gaps between agent turns. If
// the runtime's fetch rejects the dispatcher's handler protocol, that surfaces
// synchronously from dispatch before any bytes are sent, so retrying once
// without the dispatcher (and disabling it for the process) cannot
// double-send a request.
async function fetchWithNativeKeepAlive(url: string, fetchInit: RequestInit): Promise<Response> {
  const dispatcher = getNativeFetchDispatcher();
  if (!dispatcher) return globalThis.fetch(url, fetchInit);

  try {
    return await globalThis.fetch(url, { ...fetchInit, dispatcher } as FetchInitWithDispatcher);
  } catch (error) {
    if (!isDispatcherCompatibilityError(error)) throw error;
    markNativeFetchDispatcherUnsupported();
    return globalThis.fetch(url, fetchInit);
  }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value: string, key: string) => { headers[key] = value; });
  return headers;
}

function responseErrorMessage(response: Response, responseText: string, knownSecrets: readonly string[]): string {
  const requestId = response.headers.get("request-id") ?? response.headers.get("anthropic-request-id");
  const message = [
    `Anthropic Messages API stream error: ${response.status}`,
    responseText || response.statusText,
    requestId ? `request id: ${requestId}` : undefined,
  ].filter(Boolean).join("; ");
  return redactSensitiveText(message, knownSecrets);
}

async function assertOkResponse(response: Response, options: NativeStreamRequestOptions): Promise<void> {
  if (response.ok) return;
  throw new Error(responseErrorMessage(response, await response.text(), options.knownSecrets ?? []));
}

export async function streamNativeMessagesSse(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions = {},
): Promise<string> {
  const { response, cleanup } = await fetchNativeMessagesResponse(request, options);
  try {
    await options.onResponse?.({ status: response.status, headers: responseHeaders(response) });
    const responseText = await response.text();
    if (!response.ok) throw new Error(responseErrorMessage(response, responseText, options.knownSecrets ?? []));
    return responseText;
  } finally {
    cleanup();
  }
}

type NoProgressWatchdog = {
  readonly timeout: Promise<never>;
  beginRead: () => void;
  endRead: () => void;
  cleanup: () => void;
};

function createNoProgressWatchdog(noProgressTimeoutMs: number | undefined): NoProgressWatchdog | undefined {
  if (!noProgressTimeoutMs || noProgressTimeoutMs <= 0) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let readStartedAt = performance.now();
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const errorMessage = `Anthropic Messages API stream made no progress for ${noProgressTimeoutMs}ms`;

  const arm = (delayMs: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (!reading) return;

      const elapsedMs = performance.now() - readStartedAt;
      const remainingMs = noProgressTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        rejectTimeout(new Error(errorMessage));
        return;
      }
      arm(remainingMs);
    }, delayMs);
  };

  return {
    timeout,
    beginRead: () => {
      reading = true;
      readStartedAt = performance.now();
      if (!timer) arm(noProgressTimeoutMs);
    },
    endRead: () => { reading = false; },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      reading = false;
    },
  };
}

async function* responseBodyTextChunks(
  response: Response,
  noProgressTimeoutMs: number | undefined,
): AsyncGenerator<string> {
  if (!response.body) {
    yield await response.text();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const watchdog = createNoProgressWatchdog(noProgressTimeoutMs);
  try {
    while (true) {
      watchdog?.beginRead();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await (watchdog
          ? Promise.race([reader.read(), watchdog.timeout])
          : reader.read());
      } finally {
        watchdog?.endRead();
      }
      const { value, done } = result;
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    watchdog?.cleanup();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamNativeMessagesSseEvents(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions = {},
): Promise<AsyncIterable<AnthropicSseEvent>> {
  // Incremental SSE streams must not keep an absolute post-response timeout:
  // Pi forwards its default 300s HTTP idle timeout as timeoutMs, and long active
  // tool-input streams (large write/edit JSON) can legitimately exceed that
  // while still making progress. The body no-progress watchdog below handles
  // genuinely stalled streams after response headers arrive.
  const { response, cleanup } = await fetchNativeMessagesResponse(request, options, { includeTotalTimeout: false });
  try {
    await options.onResponse?.({ status: response.status, headers: responseHeaders(response) });
    await assertOkResponse(response, options);
  } catch (error) {
    cleanup();
    throw error;
  }

  const noProgressTimeoutMs = options.streamNoProgressTimeoutMs ?? DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS;

  async function* events(): AsyncGenerator<AnthropicSseEvent> {
    try {
      yield* parseAnthropicSseStream(responseBodyTextChunks(response, noProgressTimeoutMs), { knownSecrets: options.knownSecrets });
    } finally {
      cleanup();
    }
  }

  return events();
}

export function createNativeStreamSimple(
  dependencies: NativeStreamSimpleDependencies = {},
) {
  const loadCredentials = dependencies.loadCredentials
    ?? ((options?: NativeCredentialLoadOptions) => loadClaudeCodeCredentials(undefined, options));
  const buildRequest = dependencies.buildRequest ?? buildNativeMessagesRequest;
  const streamRequest = dependencies.streamRequest ?? streamNativeMessagesSseEvents;
  const parseSse = dependencies.parseSse ?? parseAnthropicSse;
  const now = dependencies.now ?? Date.now;
  const resolveMicrocompactionConfig = dependencies.microcompactionConfig ?? resolveNativeMicrocompactionConfig;

  return (
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions = {},
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: now(),
      };
      let knownSecrets: string[] = [];
      const contractState: NativeStreamContractState = {
        sawMessageStart: false,
        sawMessageStop: false,
        fallbackBlockIndexes: new Set(),
      };
      const diagnostics: {
        responseStatus?: number;
        anthropicRequestId?: string;
        lastEventType?: string;
        sawToolBlock: boolean;
        responseHeaderParts?: string[];
      } = { sawToolBlock: false };
      let requestForDiagnostics: NativeMessagesRequest | undefined;
      const contentIndexByAnthropicIndex = new Map<number, number>();
      const toolJsonByContentIndex: ToolJsonState = new Map();

      try {
        stream.push({ type: "start", partial: output });
        assertClaudeSubscriptionProvider(model);

        // Credential loading is file/Keychain I/O (or an OAuth refresh round
        // trip) and does not depend on the converted payload, so it runs
        // concurrently with the CPU-bound Pi -> Anthropic conversion below.
        // The no-op catch prevents an unhandled rejection when conversion
        // throws first; the await after conversion still surfaces the
        // original credential error to the stream.
        const accessTokenPromise = loadCredentials();
        accessTokenPromise.catch(() => {});
        // Keep-recent microcompaction projects the message array before Pi ->
        // Anthropic conversion. The Pi transcript is untouched; only what this
        // request sends to Anthropic is compacted. Disabled by default.
        const microcompactionConfig = resolveMicrocompactionConfig();
        const microcompaction = projectMessagesForNativeMicrocompaction(context.messages, microcompactionConfig);
        if (microcompactionConfig.enabled) {
          recordNativeMicrocompaction({ timestamp: now(), model: model.id, stats: microcompaction.stats });
        }
        const projectedContext: Context = microcompaction.messages === context.messages
          ? context
          // projectMessages returns a fresh mutable array only when it compacts;
          // the readonly type is a guard against accidental in-place mutation.
          : { ...context, messages: microcompaction.messages as Message[] };
        const rawPayload = contextToPayload(model, projectedContext, options);
        const payloadResult = options.onPayload
          ? ((await options.onPayload(rawPayload, model)) ?? rawPayload)
          : rawPayload;
        const payload = payloadResult as Record<string, unknown>;
        const requestInput = {
          payload,
          cacheRetention: options.cacheRetention,
          supportsLongCacheRetention: nativeCompat(model)?.supportsLongCacheRetention ?? true,
        };
        let accessToken = await accessTokenPromise;
        knownSecrets = accessTokenSecrets(accessToken);
        let request = buildRequest({ accessToken, ...requestInput });
        requestForDiagnostics = request;
        const streamRequestOptions = () => ({
          signal: options.signal,
          knownSecrets,
          timeoutMs: options.timeoutMs,
          streamNoProgressTimeoutMs: (options as { streamNoProgressTimeoutMs?: number }).streamNoProgressTimeoutMs,
          onResponse: async (response: ProviderResponse) => {
            diagnostics.responseStatus = response.status;
            const requestId = response.headers["request-id"] ?? response.headers["anthropic-request-id"];
            if (typeof requestId === "string" && requestId.length > 0) {
              diagnostics.anthropicRequestId = requestId;
            }
            const responseHeaderParts = responseHeaderDiagnosticParts(response.headers);
            if (responseHeaderParts.length > 0) diagnostics.responseHeaderParts = responseHeaderParts;
            await options.onResponse?.(response, model);
          },
        });
        let eventSource: NativeStreamRequestResult;
        try {
          eventSource = await streamRequest(request, streamRequestOptions());
        } catch (error) {
          if (options.signal?.aborted) throw error;

          if (Array.isArray(payload.fallbacks) && isServerSideFallbackRejectionError(error)) {
            // The lane rejected the `fallbacks` beta (e.g. not enabled for this
            // account). Retry once without it and latch off for the process;
            // refusals then surface as terminal errors instead of falling back.
            serverSideFallbackUnsupported = true;
            delete payload.fallbacks;
            request = buildRequest({ accessToken, ...requestInput });
            requestForDiagnostics = request;
            eventSource = await streamRequest(request, streamRequestOptions());
          } else if (isRefreshableAuthenticationError(error)) {
            accessToken = await loadCredentials({ forceRefresh: true, previousAccessToken: accessToken });
            knownSecrets = appendUniqueSecrets(knownSecrets, accessTokenSecrets(accessToken));
            request = buildRequest({ accessToken, ...requestInput });
            requestForDiagnostics = request;
            eventSource = await streamRequest(request, streamRequestOptions());
          } else {
            throw error;
          }
        }
        const events = typeof eventSource === "string"
          ? parseSse(eventSource, { knownSecrets })
          : eventSource;

        for await (const event of events) {
          diagnostics.lastEventType = event.type;
          if (event.type === "toolUseStart") diagnostics.sawToolBlock = true;
          applyAnthropicEvent(
            stream,
            model,
            output,
            event,
            contentIndexByAnthropicIndex,
            toolJsonByContentIndex,
            contractState,
            options.sessionId,
          );
        }

        if (!contractState.sawMessageStart) {
          throw new Error("Anthropic stream contract violation: missing message_start.");
        }
        if (contentIndexByAnthropicIndex.size > 0) {
          throw new Error("Anthropic stream contract violation: missing content block stop before message_stop.");
        }
        if (!contractState.sawMessageStop) {
          throw new Error("Anthropic stream contract violation: missing message_stop.");
        }

        if (options.signal?.aborted) throw new Error("Request was aborted");
        if (output.stopReason === "error") {
          if (contractState.rawStopReason === "refusal") {
            const requestDiagnostics = requestDiagnosticsFromRequest(request);
            const category = contractState.refusalCategory ? ` (category: ${contractState.refusalCategory})` : "";
            const fallbackNote = requestDiagnostics.fallbackModels?.length
              ? `; the server-side fallback (${requestDiagnostics.fallbackModels.join(", ")}) also declined or was unavailable`
              : "";
            throw new Error(
              `Anthropic safety classifiers declined this request with stop_reason=refusal${category}${fallbackNote}. `
                + "Rephrase the request or switch to an Opus model for this turn.",
            );
          }
          throw new Error(
            `Anthropic stream ended with an unsupported stop reason${contractState.rawStopReason ? ` '${contractState.rawStopReason}'` : ""}`,
          );
        }

        stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
        stream.end();

        // Record diagnostics only after the done event is out. The request
        // fingerprint (deep key-sorted stringify + SHA-256 over the whole body,
        // including full message history) costs ~7 ms per MB of request body
        // and is never read mid-stream; computing it before `done` would
        // delay Pi's continuation (tool execution, next turn) by that much on
        // every request. setImmediate yields the event loop first so the done
        // event is consumed before the hash work runs. `output` is final and
        // `request` still holds the body that was actually streamed, including
        // the rebuilt body on auth retry. Telemetry is best-effort in-process
        // diagnostics: failures must never surface after the stream has ended.
        setImmediate(() => {
          try {
            const usageMetrics = {
              input: output.usage.input,
              output: output.usage.output,
              cacheRead: output.usage.cacheRead,
              cacheWrite: output.usage.cacheWrite,
              totalTokens: output.usage.totalTokens,
            };
            const requestFingerprint = fingerprintNativeRequestShape(request.body);
            recordNativeCacheDiagnosticSample({
              timestamp: output.timestamp,
              model: model.id,
              ...(output.responseId ? { responseId: output.responseId } : {}),
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              fingerprint: requestFingerprint,
              usage: usageMetrics,
            });
            recordNativeUsage({
              timestamp: output.timestamp,
              model: model.id,
              ...(output.responseModel ? { responseModel: output.responseModel } : {}),
              ...(output.responseId ? { responseId: output.responseId } : {}),
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              usage: usageMetrics,
              requestFingerprint: requestFingerprint.overall,
            });
          } catch {
            // Best-effort diagnostics; the response was already delivered.
          }
        });
      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        const baseMessage = errorMessageFrom(error, knownSecrets);
        const requestDiagnostics = requestForDiagnostics
          ? requestDiagnosticsFromRequest(requestForDiagnostics)
          : {};
        const anthropicErrorType = anthropicErrorTypeFromMessage(baseMessage);
        const diagnosticParts = [
          diagnostics.responseStatus !== undefined ? `status=${diagnostics.responseStatus}` : undefined,
          diagnostics.anthropicRequestId ? `request_id=${diagnostics.anthropicRequestId}` : undefined,
          anthropicErrorType ? `anthropic_error_type=${anthropicErrorType}` : undefined,
          diagnostics.lastEventType ? `last_event=${diagnostics.lastEventType}` : undefined,
          `saw_message_stop=${contractState.sawMessageStop}`,
          `saw_tool_block=${diagnostics.sawToolBlock}`,
          `model=${model.id}`,
          `model_provider=${diagnosticToken(model.provider)}`,
          `model_api=${diagnosticToken(String(model.api))}`,
          `model_context_window=${model.contextWindow}`,
          `model_max_tokens=${model.maxTokens}`,
          `model_reasoning=${!!model.reasoning}`,
          options.reasoning ? `requested_reasoning=${diagnosticToken(options.reasoning)}` : undefined,
          typeof options.maxTokens === "number" ? `requested_max_tokens=${options.maxTokens}` : undefined,
          output.responseModel ? `response_model=${output.responseModel}` : undefined,
          output.responseId ? `response_id=${output.responseId}` : undefined,
          ...(diagnostics.responseHeaderParts ?? []),
          requestDiagnostics.method ? `method=${requestDiagnostics.method}` : undefined,
          requestDiagnostics.endpoint ? `endpoint=${diagnosticToken(requestDiagnostics.endpoint)}` : undefined,
          requestDiagnostics.authKind ? `auth=${requestDiagnostics.authKind}` : undefined,
          requestDiagnostics.anthropicVersion ? `anthropic_version=${diagnosticToken(requestDiagnostics.anthropicVersion)}` : undefined,
          requestDiagnostics.contentType ? `request_content_type=${diagnosticToken(requestDiagnostics.contentType)}` : undefined,
          requestDiagnostics.requestModel && requestDiagnostics.requestModel !== model.id
            ? `request_model=${requestDiagnostics.requestModel}`
            : undefined,
          requestDiagnostics.bodyBytes !== undefined ? `body_bytes=${requestDiagnostics.bodyBytes}` : undefined,
          requestDiagnostics.bodyShapeHash ? `body_shape_hash=${requestDiagnostics.bodyShapeHash}` : undefined,
          requestDiagnostics.bodyKeys?.length ? `body_keys=${requestDiagnostics.bodyKeys.map((key) => diagnosticToken(key)).join("|")}` : undefined,
          requestDiagnostics.bodyConfigKeys?.length ? `body_config_keys=${formatStringList(requestDiagnostics.bodyConfigKeys)}` : undefined,
          requestDiagnostics.maxTokens !== undefined ? `max_tokens=${requestDiagnostics.maxTokens}` : undefined,
          requestDiagnostics.stream !== undefined ? `stream=${requestDiagnostics.stream}` : undefined,
          requestDiagnostics.thinkingType ? `thinking=${requestDiagnostics.thinkingType}` : undefined,
          requestDiagnostics.thinkingBudgetTokens !== undefined ? `thinking_budget_tokens=${requestDiagnostics.thinkingBudgetTokens}` : undefined,
          requestDiagnostics.thinkingDisplay ? `thinking_display=${diagnosticToken(requestDiagnostics.thinkingDisplay)}` : undefined,
          requestDiagnostics.effort ? `effort=${requestDiagnostics.effort}` : undefined,
          requestDiagnostics.outputConfigKeys?.length ? `output_config_keys=${formatStringList(requestDiagnostics.outputConfigKeys)}` : undefined,
          requestDiagnostics.samplingKeys?.length ? `sampling_keys=${formatStringList(requestDiagnostics.samplingKeys)}` : undefined,
          requestDiagnostics.toolCount !== undefined ? `tools=${requestDiagnostics.toolCount}` : undefined,
          requestDiagnostics.toolNames?.length ? `tool_names=${formatStringList(requestDiagnostics.toolNames)}` : undefined,
          requestDiagnostics.toolJsonBytes !== undefined ? `tool_json_bytes_total=${requestDiagnostics.toolJsonBytes}` : undefined,
          requestDiagnostics.toolSchemaBytes !== undefined ? `tool_schema_bytes_total=${requestDiagnostics.toolSchemaBytes}` : undefined,
          requestDiagnostics.toolDescriptionBytes !== undefined ? `tool_description_bytes_total=${requestDiagnostics.toolDescriptionBytes}` : undefined,
          requestDiagnostics.toolShapeHash ? `tool_shape_hash=${requestDiagnostics.toolShapeHash}` : undefined,
          requestDiagnostics.toolPrefixCounts ? `tool_prefix_counts=${formatPrefixCounts(requestDiagnostics.toolPrefixCounts)}` : undefined,
          requestDiagnostics.toolStats?.length ? `tool_stats=${formatToolStats(requestDiagnostics.toolStats)}` : undefined,
          requestDiagnostics.systemBlockCount !== undefined ? `system_blocks=${requestDiagnostics.systemBlockCount}` : undefined,
          requestDiagnostics.systemTextBlockCount !== undefined ? `system_text_blocks=${requestDiagnostics.systemTextBlockCount}` : undefined,
          requestDiagnostics.systemTextBytes !== undefined ? `system_text_bytes=${requestDiagnostics.systemTextBytes}` : undefined,
          requestDiagnostics.messageCount !== undefined ? `messages=${requestDiagnostics.messageCount}` : undefined,
          requestDiagnostics.messageBytes !== undefined ? `message_bytes=${requestDiagnostics.messageBytes}` : undefined,
          requestDiagnostics.messageRoleCounts ? `message_roles=${formatCounts(requestDiagnostics.messageRoleCounts)}` : undefined,
          requestDiagnostics.messageContentBlockCounts ? `message_blocks=${formatCounts(requestDiagnostics.messageContentBlockCounts)}` : undefined,
          requestDiagnostics.messageTextBytes !== undefined ? `message_text_bytes=${requestDiagnostics.messageTextBytes}` : undefined,
          requestDiagnostics.messageImageBlocks !== undefined ? `message_image_blocks=${requestDiagnostics.messageImageBlocks}` : undefined,
          requestDiagnostics.messageToolUseBlocks !== undefined ? `message_tool_use_blocks=${requestDiagnostics.messageToolUseBlocks}` : undefined,
          requestDiagnostics.messageToolResultBlocks !== undefined ? `message_tool_result_blocks=${requestDiagnostics.messageToolResultBlocks}` : undefined,
          requestDiagnostics.messageThinkingBlocks !== undefined ? `message_thinking_blocks=${requestDiagnostics.messageThinkingBlocks}` : undefined,
          requestDiagnostics.cacheControlCount !== undefined ? `cache_controls=${requestDiagnostics.cacheControlCount}` : undefined,
          requestDiagnostics.metadataKeys?.length ? `metadata_keys=${formatStringList(requestDiagnostics.metadataKeys)}` : undefined,
          requestDiagnostics.anthropicBeta ? `anthropic_beta=${requestDiagnostics.anthropicBeta.split(",").map((beta) => diagnosticToken(beta)).join("|")}` : undefined,
          requestDiagnostics.requestMarkers ? `request_markers=${requestDiagnostics.requestMarkers}` : undefined,
          requestDiagnostics.fallbackModels?.length ? `fallbacks=${requestDiagnostics.fallbackModels.join("|")}` : undefined,
          requestDiagnostics.disableParallelToolUse !== undefined
            ? `disable_parallel_tool_use=${requestDiagnostics.disableParallelToolUse}`
            : undefined,
          contentIndexByAnthropicIndex.size > 0 ? `open_content_blocks=${contentIndexByAnthropicIndex.size}` : undefined,
          ...activeToolDiagnosticParts(toolJsonByContentIndex),
          output.usage.output > 0 ? `usage_output=${output.usage.output}` : undefined,
          output.usage.cacheRead > 0 ? `usage_cache_read=${output.usage.cacheRead}` : undefined,
          output.usage.cacheWrite > 0 ? `usage_cache_write=${output.usage.cacheWrite}` : undefined,
        ].filter((part): part is string => part !== undefined);
        output.errorMessage = diagnosticParts.length > 0
          ? `${baseMessage} [${diagnosticParts.join("; ")}]`
          : baseMessage;

        // Drop tool-call blocks from errored assistant messages that never saw a
        // clean message_stop: an incomplete tool_use is not safe to expose as an
        // executable-looking tool call. Aborted messages preserve whatever Pi
        // already streamed so partial output can still be inspected.
        if (output.stopReason === "error" && !contractState.sawMessageStop) {
          output.content = output.content.filter((block) => block.type !== "toolCall");
        }

        stream.push({
          type: "error",
          reason: output.stopReason === "aborted" ? "aborted" : "error",
          error: output,
        });
        stream.end();
      }
    })();

    return stream;
  };
}

export const streamNativeClaudeSubscription = createNativeStreamSimple();
