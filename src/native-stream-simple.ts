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
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
} from "./models.ts";
import {
  fingerprintNativeRequestShape,
  recordNativeCacheDiagnosticSample,
} from "./native-cache-diagnostics.ts";
import {
  ANTHROPIC_MESSAGES_URL,
  buildNativeMessagesRequest,
  type NativeMessagesRequest,
  type NativeMessagesRequestInput,
} from "./native-request.ts";
import { recordNativeUsage } from "./native-usage-telemetry.ts";
import { redactSensitiveText } from "./redaction.ts";
import { isRecord } from "./type-guards.ts";

export type NativeStreamRequestOptions = {
  signal?: AbortSignal;
  knownSecrets?: readonly string[];
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
  timeoutMs?: number;
  streamNoProgressTimeoutMs?: number;
};

// Default upper bound on how long an Anthropic Messages stream may go without
// progress (no response headers, no SSE chunk) before the request is aborted
// with a clear progress error. Anthropic emits SSE `ping` events roughly every
// ~15 s during normal operation, so 45 s gives multiple pings of headroom while
// still surfacing a stuck connection instead of leaving Pi on "Working...".
export const DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS = 45_000;

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

type ToolJsonState = Map<number, string>;
type NativeStreamContractState = {
  sawMessageStart: boolean;
  sawMessageStop: boolean;
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

const VALID_JSON_STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function escapeJsonControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

function isJsonControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function repairJsonStringLiterals(json: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index] ?? "";
    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_STRING_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }

    repaired += isJsonControlCharacter(char) ? escapeJsonControlCharacter(char) : char;
  }

  return repaired;
}

function completePartialJsonContainers(json: string): string {
  let completed = "";
  let inString = false;
  let escaping = false;
  const closingStack: string[] = [];

  for (let index = 0; index < json.length; index++) {
    const char = json[index] ?? "";
    completed += char;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      closingStack.push("}");
    } else if (char === "[") {
      closingStack.push("]");
    } else if (char === "}" || char === "]") {
      if (closingStack.at(-1) === char) closingStack.pop();
    }
  }

  if (escaping) completed += "\\";
  if (inString) completed += '"';
  while (closingStack.length > 0) completed += closingStack.pop();
  return completed;
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
      } else if (canReplayThinking && !block.redacted && block.thinkingSignature && block.thinking.trim().length > 0) {
        // Only replay fully-signed thinking blocks from the exact same native Claude
        // subscription model. Signatures are provider/model payloads, not generic Pi
        // metadata; replaying foreign signatures makes Anthropic reject the request.
        content.push({
          type: "thinking",
          thinking: sanitizeSurrogates(block.thinking),
          signature: block.thinkingSignature,
        });
      } else if (!canReplayThinking && block.redacted !== true && block.thinking.trim().length > 0) {
        // Cross-provider/model visible reasoning can be preserved as ordinary assistant
        // text, but its signature must never be replayed as an Anthropic thinking block.
        content.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
      }
    } else if (block.type === "toolCall") {
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

function shouldReplayAssistantMessage(message: AssistantMessage): boolean {
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function convertMessages(messages: readonly Message[], model: Model<Api>): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];
  const mapToolUseId = createAnthropicToolUseIdMapper();
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  function flushToolResults(): void {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  }

  for (const message of messages) {
    if (message.role === "toolResult") {
      pendingToolResults.push(convertToolResultBlock(message, mapToolUseId));
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      const convertedMessage = convertUserMessage(message);
      if (convertedMessage) converted.push(convertedMessage);
    } else if (message.role === "assistant") {
      if (!shouldReplayAssistantMessage(message)) continue;
      const convertedMessage = convertAssistantMessage(message, model, mapToolUseId);
      if (convertedMessage) converted.push(convertedMessage);
    }
  }

  flushToolResults();
  return converted;
}

function supportsEagerToolInputStreaming(model: Model<Api>): boolean {
  return ((model.compat as { supportsEagerToolInputStreaming?: boolean } | undefined)?.supportsEagerToolInputStreaming) ?? true;
}

function convertTools(tools: readonly Tool[] | undefined, eagerInputStreaming: boolean): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(eagerInputStreaming ? { eager_input_streaming: true } : {}),
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
const ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN = /\bopus-4[-.]7(?:\b|-)/;
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

function requiresAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN.test(modelId);
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

function contextToPayload(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): Record<string, unknown> {
  const eagerInputStreaming = supportsEagerToolInputStreaming(model);
  const tools = convertTools(context.tools, eagerInputStreaming);
  const payload: Record<string, unknown> = {
    model: model.id,
    max_tokens: options.maxTokens ?? model.maxTokens,
    messages: convertMessages(context.messages, model),
    system: context.systemPrompt ?? "",
    stream: true,
  };

  if (tools) payload.tools = tools;
  if (options.metadata) payload.metadata = options.metadata;

  const thinkingEnabled = model.reasoning && !!options.reasoning;
  if (thinkingEnabled && requiresAdaptiveThinking(model.id)) {
    payload.thinking = { type: "adaptive", display: "summarized" };
    payload.output_config = { effort: mapThinkingLevelToEffort(model, options) };
  } else {
    const requestedBudget = model.reasoning ? thinkingBudget(options) : 0;
    const { maxTokens, budgetTokens } = resolveManualThinkingPayload(model, options, requestedBudget);
    payload.max_tokens = maxTokens;
    if (budgetTokens > 0) {
      payload.thinking = { type: "enabled", budget_tokens: budgetTokens };
    } else if (typeof options.temperature === "number") {
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

function tryParseToolArgumentsCandidate(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return undefined;
  }
}

function parseToolArgumentsFromJson(partialJson: string): Record<string, unknown> {
  if (partialJson.trim().length === 0) return {};

  const repairedJson = repairJsonStringLiterals(partialJson);
  const completedJson = completePartialJsonContainers(partialJson);
  const completedRepairedJson = completePartialJsonContainers(repairedJson);

  for (const candidate of [partialJson, repairedJson, completedJson, completedRepairedJson]) {
    const parsed = tryParseToolArgumentsCandidate(candidate);
    if (parsed !== undefined) return parsed;
  }

  return {};
}

function setToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  block.arguments = parseToolArgumentsFromJson(partialJson);
}

function setFinalToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  if (partialJson.length === 0) return;
  block.arguments = parseToolArgumentsFromJson(partialJson);
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
      arguments: { ...event.input },
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    toolJsonByContentIndex.set(contentIndex, "");
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "toolUseInputDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: tool input delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "toolCall") throw new Error("Anthropic stream contract violation: tool input delta for non-tool block.");
    const partialJson = (toolJsonByContentIndex.get(contentIndex) ?? "") + event.partialJson;
    toolJsonByContentIndex.set(contentIndex, partialJson);
    setToolArgumentsFromJson(block, partialJson);
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
      const partialJson = toolJsonByContentIndex.get(contentIndex) ?? "";
      setFinalToolArgumentsFromJson(block, partialJson);
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
): { signal?: AbortSignal; responseStarted: () => void; cleanup: () => void } {
  const totalTimeoutMs = options.timeoutMs;
  const responseStartTimeoutMs = options.streamNoProgressTimeoutMs
    ?? options.timeoutMs
    ?? DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS;
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

  const { signal, responseStarted, cleanup } = combineStreamAbortSignals(options.signal, options);
  try {
    const response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
    responseStarted();
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(
      `Anthropic Messages API stream transport error: ${errorMessageFrom(error, options.knownSecrets ?? [])}`,
    );
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

async function readReaderWithNoProgressTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  noProgressTimeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<T>> {
  if (!noProgressTimeoutMs || noProgressTimeoutMs <= 0) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Anthropic Messages API stream made no progress for ${noProgressTimeoutMs}ms`)),
      noProgressTimeoutMs,
    );
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  try {
    while (true) {
      const { value, done } = await readReaderWithNoProgressTimeout(reader, noProgressTimeoutMs);
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamNativeMessagesSseEvents(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions = {},
): Promise<AsyncIterable<AnthropicSseEvent>> {
  const { response, cleanup } = await fetchNativeMessagesResponse(request, options);
  await options.onResponse?.({ status: response.status, headers: responseHeaders(response) });
  try {
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

      try {
        stream.push({ type: "start", partial: output });
        assertClaudeSubscriptionProvider(model);

        let accessToken = await loadCredentials();
        knownSecrets = accessTokenSecrets(accessToken);
        const rawPayload = contextToPayload(model, context, options);
        const payloadResult = options.onPayload
          ? ((await options.onPayload(rawPayload, model)) ?? rawPayload)
          : rawPayload;
        const payload = payloadResult as Record<string, unknown>;
        const requestInput = {
          payload,
          cacheRetention: options.cacheRetention,
          supportsLongCacheRetention: ((model.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention) ?? true,
          supportsEagerToolInputStreaming: supportsEagerToolInputStreaming(model),
        };
        let request = buildRequest({ accessToken, ...requestInput });
        let requestFingerprint = fingerprintNativeRequestShape(request.body);
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
          requestFingerprint = fingerprintNativeRequestShape(request.body);
          eventSource = await streamRequest(request, streamRequestOptions());
        }
        const events = typeof eventSource === "string"
          ? parseSse(eventSource, { knownSecrets })
          : eventSource;
        const contentIndexByAnthropicIndex = new Map<number, number>();
        const toolJsonByContentIndex: ToolJsonState = new Map();

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

        const usageMetrics = {
          input: output.usage.input,
          output: output.usage.output,
          cacheRead: output.usage.cacheRead,
          cacheWrite: output.usage.cacheWrite,
          totalTokens: output.usage.totalTokens,
        };
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

        stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        const baseMessage = errorMessageFrom(error, knownSecrets);
        const diagnosticParts = [
          diagnostics.responseStatus !== undefined ? `status=${diagnostics.responseStatus}` : undefined,
          diagnostics.anthropicRequestId ? `request_id=${diagnostics.anthropicRequestId}` : undefined,
          diagnostics.lastEventType ? `last_event=${diagnostics.lastEventType}` : undefined,
          `saw_message_stop=${contractState.sawMessageStop}`,
          `saw_tool_block=${diagnostics.sawToolBlock}`,
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
