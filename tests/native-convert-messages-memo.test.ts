import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";

import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
} from "../src/models.ts";
import {
  convertMessages,
  getSanitizeSurrogatesCallCountForTests,
  resetConvertMessagesMemoForTests,
  resetSanitizeSurrogatesCallCountForTests,
} from "../src/native-stream-simple.ts";

function nativeModel(id: string): Model<Api> {
  return {
    id,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    baseUrl: "https://api.anthropic.com",
  } as Model<Api>;
}

// A non-native model: isSameNativeClaudeSubscriptionModel(message, model) is
// false, so signed thinking is NOT replayed for it.
function foreignModel(id: string): Model<Api> {
  return {
    id,
    provider: "some-other-provider",
    api: "some-other-api",
    baseUrl: "https://example.com",
  } as Model<Api>;
}

function usage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

// Multi-turn fixture exercising every conversion path that carries byte
// volume: user messages, a tool-call assistant turn, coalesced tool results,
// and a signed-thinking assistant turn with no tool calls.
function multiTurnMessages(modelId: string): Message[] {
  const toolCallAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Listing files." },
      { type: "toolCall", id: "call:7", name: "bash", arguments: { command: "ls" } },
    ],
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    model: modelId,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: 2,
  };

  const thinkingAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Reasoning about the layout.", thinkingSignature: "sig-abc" },
      { type: "text", text: "Here is the summary." },
    ],
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    model: modelId,
    usage: usage(),
    stopReason: "stop",
    timestamp: 5,
  };

  return [
    { role: "user", content: "List the files.", timestamp: 1 },
    toolCallAssistant,
    { role: "toolResult", toolCallId: "call:7", toolName: "bash", content: [{ type: "text", text: "README.md\nsrc\ntests" }], isError: false, timestamp: 3 },
    { role: "user", content: "Now summarize the layout.", timestamp: 4 },
    thinkingAssistant,
    { role: "user", content: "Thanks!", timestamp: 6 },
  ];
}

beforeEach(() => {
  resetConvertMessagesMemoForTests();
  resetSanitizeSurrogatesCallCountForTests();
});

test("memoized conversion is byte-identical to a cold conversion across a multi-turn fixture", () => {
  const model = nativeModel("claude-opus-4-8");
  const messages = multiTurnMessages(model.id);

  const cold = convertMessages(messages, model);
  // Warm pass: every prior message object is now memoized.
  const warm = convertMessages(messages, model);

  assert.deepEqual(warm, cold);
});

test("repeated conversion reuses cached entries instead of re-sanitizing memoized messages", () => {
  const model = nativeModel("claude-opus-4-8");
  const messages = multiTurnMessages(model.id);

  convertMessages(messages, model);
  const coldSanitizeCount = getSanitizeSurrogatesCallCountForTests();
  assert.ok(coldSanitizeCount > 0, "cold pass should sanitize text blocks");

  resetSanitizeSurrogatesCallCountForTests();
  convertMessages(messages, model);
  const warmSanitizeCount = getSanitizeSurrogatesCallCountForTests();

  // User messages, tool results, and the no-tool-call signed-thinking assistant
  // turn are all memoized; only the tool-call assistant turn re-sanitizes.
  assert.ok(
    warmSanitizeCount < coldSanitizeCount,
    `warm sanitize count (${warmSanitizeCount}) should drop below cold (${coldSanitizeCount})`,
  );
});

test("a session that only appends a new turn reuses every prior converted message", () => {
  const model = nativeModel("claude-opus-4-8");
  const base = multiTurnMessages(model.id);

  convertMessages(base, model);
  resetSanitizeSurrogatesCallCountForTests();

  // Append a brand-new user message (new object); all prior objects are reused.
  const next: Message[] = [...base, { role: "user", content: "One more thing.", timestamp: 7 }];
  convertMessages(next, model);

  // Cold pass sanitizes 6 text blocks. On the follow-up turn only two remain:
  // the single appended user message, plus the tool-call assistant turn (which
  // is intentionally never memoized because its output depends on the stateful
  // tool-id mapper and replay context). Every prior user message, tool result,
  // and the no-tool-call signed-thinking turn are reused.
  assert.equal(getSanitizeSurrogatesCallCountForTests(), 2);
});

test("switching model does NOT reuse a model-dependent assistant conversion", () => {
  const messages = multiTurnMessages("claude-opus-4-8");

  const native = nativeModel("claude-opus-4-8");
  const nativeConverted = convertMessages(messages, native);

  const foreign = foreignModel("gpt-x");
  const foreignConverted = convertMessages(messages, foreign);

  // The signed-thinking assistant turn must differ: native replays a `thinking`
  // block byte-for-byte; the foreign model degrades it to assistant `text`.
  const nativeThinking = nativeConverted.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "thinking"),
  );
  assert.ok(nativeThinking, "native model should replay a thinking block");

  const foreignThinking = foreignConverted.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "thinking"),
  );
  assert.equal(foreignThinking, undefined, "foreign model must not reuse the native thinking conversion");
});
