import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
} from "./models.ts";
import {
  assistantToolCallIds,
  hasCompleteImmediateToolResults,
  shouldReplayAssistantMessage,
} from "./native-tool-sequencing.ts";

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
