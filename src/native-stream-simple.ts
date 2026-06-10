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
};

type NativeStreamRequestDiagnostics = {
  requestModel?: string;
  maxTokens?: number;
  thinkingType?: string;
  effort?: string;
  toolCount?: number;
  disableParallelToolUse?: boolean;
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

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
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
  return {
    type: "tool_result",
    tool_use_id: mapToolUseId(message.toolCallId),
    content: textBlocksToAnthropic(message.content),
    is_error: message.isError,
  };
}

function convertMessages(messages: readonly Message[], model: Model<Api>): AnthropicMessage[] {
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

function requestDiagnosticsFromBody(body: Record<string, unknown>): NativeStreamRequestDiagnostics {
  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
  const toolChoice = isRecord(body.tool_choice) ? body.tool_choice : undefined;
  const disableParallelToolUse = typeof toolChoice?.disable_parallel_tool_use === "boolean"
    ? toolChoice.disable_parallel_tool_use
    : undefined;

  return {
    requestModel: safeStringField(body.model),
    maxTokens: safeNumberField(body.max_tokens),
    thinkingType: thinking ? safeStringField(thinking.type) : undefined,
    effort: outputConfig ? safeStringField(outputConfig.effort) : undefined,
    toolCount: Array.isArray(body.tools) ? body.tools.length : undefined,
    ...(disableParallelToolUse !== undefined ? { disableParallelToolUse } : {}),
  };
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
      };
      const diagnostics: {
        responseStatus?: number;
        anthropicRequestId?: string;
        lastEventType?: string;
        sawToolBlock: boolean;
      } = { sawToolBlock: false };
      let requestDiagnostics: NativeStreamRequestDiagnostics = {};
      const contentIndexByAnthropicIndex = new Map<number, number>();
      const toolJsonByContentIndex: ToolJsonState = new Map();

      try {
        stream.push({ type: "start", partial: output });
        assertClaudeSubscriptionProvider(model);

        let accessToken = await loadCredentials();
        knownSecrets = accessTokenSecrets(accessToken);
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
        let request = buildRequest({ accessToken, ...requestInput });
        requestDiagnostics = requestDiagnosticsFromBody(request.body);
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
            await options.onResponse?.(response, model);
          },
        });
        let eventSource: NativeStreamRequestResult;
        try {
          eventSource = await streamRequest(request, streamRequestOptions());
        } catch (error) {
          if (options.signal?.aborted || !isRefreshableAuthenticationError(error)) throw error;

          accessToken = await loadCredentials({ forceRefresh: true, previousAccessToken: accessToken });
          knownSecrets = appendUniqueSecrets(knownSecrets, accessTokenSecrets(accessToken));
          request = buildRequest({ accessToken, ...requestInput });
          requestDiagnostics = requestDiagnosticsFromBody(request.body);
          eventSource = await streamRequest(request, streamRequestOptions());
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
          throw new Error("Anthropic stream ended with an unsupported stop reason");
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
        const diagnosticParts = [
          diagnostics.responseStatus !== undefined ? `status=${diagnostics.responseStatus}` : undefined,
          diagnostics.anthropicRequestId ? `request_id=${diagnostics.anthropicRequestId}` : undefined,
          diagnostics.lastEventType ? `last_event=${diagnostics.lastEventType}` : undefined,
          `saw_message_stop=${contractState.sawMessageStop}`,
          `saw_tool_block=${diagnostics.sawToolBlock}`,
          `model=${model.id}`,
          output.responseModel ? `response_model=${output.responseModel}` : undefined,
          output.responseId ? `response_id=${output.responseId}` : undefined,
          requestDiagnostics.requestModel && requestDiagnostics.requestModel !== model.id
            ? `request_model=${requestDiagnostics.requestModel}`
            : undefined,
          requestDiagnostics.maxTokens !== undefined ? `max_tokens=${requestDiagnostics.maxTokens}` : undefined,
          requestDiagnostics.thinkingType ? `thinking=${requestDiagnostics.thinkingType}` : undefined,
          requestDiagnostics.effort ? `effort=${requestDiagnostics.effort}` : undefined,
          requestDiagnostics.toolCount !== undefined ? `tools=${requestDiagnostics.toolCount}` : undefined,
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
