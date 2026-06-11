import assert from "node:assert/strict";
import test from "node:test";

import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import { parseAnthropicSse, type AnthropicSseEvent } from "../src/anthropic-sse.ts";
import { SERVER_SIDE_FALLBACK_BETA } from "../src/constants.ts";
import { MODELS } from "../src/models.ts";
import { buildNativeMessagesRequest, type NativeMessagesRequest, type NativeMessagesRequestInput } from "../src/native-request.ts";
import {
  createNativeStreamSimple,
  resetServerSideFallbackSupportForTests,
} from "../src/native-stream-simple.ts";

const FAKE_TOKEN = "fake-native-fable-oauth-token";
const PROVIDER_ID = "claude-subscription";
const SUBSCRIPTION_NATIVE_API_ID = "claude-subscription-native";
const FABLE_THINKING_LEVEL_MAP = { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" };

function fableModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-fable-5",
    name: "claude-fable-5",
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    thinkingLevelMap: FABLE_THINKING_LEVEL_MAP,
    compat: { forceAdaptiveThinking: true, refusalFallbackModel: "claude-opus-4-8" } as never,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
    ...overrides,
  };
}

function context(): Context {
  return {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  };
}

function requestFrom(input: NativeMessagesRequestInput): NativeMessagesRequest {
  return {
    url: "mock://anthropic/messages",
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    body: input.payload,
  };
}

function createHarness(parserEvents: AnthropicSseEvent[]) {
  const buildRequestCalls: NativeMessagesRequestInput[] = [];

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async () => "mock-sse",
    parseSse: () => parserEvents,
    now: () => 1234567890,
  });

  return { streamSimple, buildRequestCalls };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  return (done as Extract<AssistantMessageEvent, { type: "done" }>).message;
}

function successfulEnd(responseId: string, model = "claude-fable-5"): AnthropicSseEvent[] {
  return [
    { type: "messageStart", responseId, model },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ];
}

test.beforeEach(() => {
  resetServerSideFallbackSupportForTests();
});

// --- registry ---

test("registers claude-fable-5 with adaptive thinking and an Opus refusal fallback", () => {
  const fable = MODELS.find((model) => model.id === "claude-fable-5");
  assert.ok(fable, "claude-fable-5 must be registered");
  assert.equal(fable.contextWindow, 1000000);
  assert.equal(fable.maxTokens, 128000);
  const compat = (fable as { compat?: Record<string, unknown> }).compat;
  assert.equal(compat?.forceAdaptiveThinking, true);
  assert.equal(compat?.refusalFallbackModel, "claude-opus-4-8");
});

// --- payload shape ---

test("fable payload uses adaptive thinking, mapped effort, and server-side fallbacks", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulEnd("msg_fable_payload"));

  await collectEvents(streamSimple(fableModel(), context(), { reasoning: "high", temperature: 0.3 }));

  const payload = buildRequestCalls[0].payload;
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(payload.output_config, { effort: "xhigh" });
  assert.deepEqual(payload.fallbacks, [{ model: "claude-opus-4-8" }]);
  assert.ok(!("temperature" in payload));
});

test("fable payload omits thinking entirely when reasoning is off but keeps fallbacks", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulEnd("msg_fable_no_reasoning"));

  await collectEvents(streamSimple(fableModel(), context(), { temperature: 0.3 }));

  const payload = buildRequestCalls[0].payload;
  assert.ok(!("thinking" in payload), "thinking must be omitted (explicit disabled 400s on Fable 5)");
  assert.ok(!("output_config" in payload));
  assert.ok(!("temperature" in payload), "sampling params 400 on Fable 5");
  assert.deepEqual(payload.fallbacks, [{ model: "claude-opus-4-8" }]);
});

test("models without refusalFallbackModel compat get no fallbacks parameter", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulEnd("msg_opus_no_fallbacks", "claude-opus-4-8"));

  await collectEvents(streamSimple(
    fableModel({ id: "claude-opus-4-8", name: "claude-opus-4-8", compat: { forceAdaptiveThinking: true } as never }),
    context(),
    { reasoning: "high" },
  ));

  assert.ok(!("fallbacks" in buildRequestCalls[0].payload));
});

// --- headers ---

test("requests carrying fallbacks add the server-side fallback beta header", () => {
  const request = buildNativeMessagesRequest({
    accessToken: FAKE_TOKEN,
    payload: {
      model: "claude-fable-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      system: "Pi system prompt",
      fallbacks: [{ model: "claude-opus-4-8" }],
    },
  });

  const betas = request.headers["anthropic-beta"].split(",");
  assert.ok(betas.includes(SERVER_SIDE_FALLBACK_BETA));
});

test("requests without fallbacks keep the base beta header set", () => {
  const request = buildNativeMessagesRequest({
    accessToken: FAKE_TOKEN,
    payload: {
      model: "claude-fable-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      system: "Pi system prompt",
    },
  });

  assert.ok(!request.headers["anthropic-beta"].includes(SERVER_SIDE_FALLBACK_BETA));
});

// --- SSE parsing ---

function sseFrames(frames: Array<Record<string, unknown>>): string {
  return frames
    .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

test("parses fallback content blocks and refusal stop details", () => {
  const sse = sseFrames([
    { type: "message_start", message: { id: "msg_fallback", model: "claude-opus-4-8", usage: { input_tokens: 10 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);

  const events = parseAnthropicSse(sse);
  const fallbackStart = events.find((event) => event.type === "fallbackStart");
  assert.deepEqual(fallbackStart, {
    type: "fallbackStart",
    index: 0,
    fromModel: "claude-fable-5",
    toModel: "claude-opus-4-8",
  });
});

test("parses stop_details category on refusal message_delta", () => {
  const sse = sseFrames([
    { type: "message_start", message: { id: "msg_refusal", model: "claude-fable-5", usage: { input_tokens: 10 } } },
    { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber" } }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ]);

  const events = parseAnthropicSse(sse);
  const delta = events.find((event) => event.type === "messageDelta");
  assert.equal(delta?.type, "messageDelta");
  assert.equal((delta as { stopReason?: string }).stopReason, "refusal");
  assert.equal((delta as { stopDetailsCategory?: string }).stopDetailsCategory, "cyber");
});

// --- stream behavior ---

test("pre-output fallback block streams to a clean done with no fallback content", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_pre_output_fallback", model: "claude-opus-4-8" },
    { type: "fallbackStart", index: 0, fromModel: "claude-fable-5", toModel: "claude-opus-4-8" },
    { type: "contentBlockStop", index: 0 },
    { type: "textStart", index: 1, text: "" },
    { type: "textDelta", index: 1, text: "fallback answer" },
    { type: "contentBlockStop", index: 1 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 3 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(fableModel(), context(), { reasoning: "medium" }));
  const message = doneMessage(events);
  assert.deepEqual(message.content, [{ type: "text", text: "fallback answer" }]);
  assert.equal(message.responseModel, "claude-opus-4-8");
});

test("mid-stream fallback strips pre-boundary thinking signatures and tool calls", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_mid_stream_fallback", model: "claude-fable-5" },
    { type: "thinkingStart", index: 0, thinking: "" },
    { type: "thinkingDelta", index: 0, thinking: "partial reasoning" },
    { type: "signatureDelta", index: 0, signature: "sig-fable" },
    { type: "contentBlockStop", index: 0 },
    { type: "toolUseStart", index: 1, id: "tool_1", name: "bash", input: {} },
    { type: "contentBlockStop", index: 1 },
    { type: "fallbackStart", index: 2, fromModel: "claude-fable-5", toModel: "claude-opus-4-8" },
    { type: "contentBlockStop", index: 2 },
    { type: "textStart", index: 3, text: "" },
    { type: "textDelta", index: 3, text: "continued" },
    { type: "contentBlockStop", index: 3 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 3 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(fableModel(), context(), { reasoning: "medium" }));
  const message = doneMessage(events);

  const toolCalls = message.content.filter((block) => block.type === "toolCall");
  assert.equal(toolCalls.length, 0, "pre-boundary tool calls must not survive a mid-stream fallback");
  const thinking = message.content.find((block) => block.type === "thinking");
  assert.ok(thinking && thinking.type === "thinking");
  assert.equal(thinking.thinkingSignature, "", "pre-boundary thinking must not replay as a signed block");
  assert.deepEqual(message.content.at(-1), { type: "text", text: "continued" });
});

test("terminal refusal surfaces a descriptive error instead of a generic stop failure", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_terminal_refusal", model: "claude-fable-5" },
    { type: "messageDelta", stopReason: "refusal", stopDetailsCategory: "cyber", usage: { output_tokens: 0 } },
    { type: "messageStop", stopReason: "refusal" },
  ]);

  const events = await collectEvents(streamSimple(fableModel(), context(), { reasoning: "medium" }));
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  const error = (last as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.match(error.errorMessage ?? "", /refusal/i);
  assert.match(error.errorMessage ?? "", /cyber/);
});

test("retries once without fallbacks when the API rejects the fallback beta, then latches off", async () => {
  const buildRequestCalls: NativeMessagesRequestInput[] = [];
  let requestCount = 0;

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async (request) => {
      requestCount += 1;
      if (Array.isArray(request.body.fallbacks)) {
        throw new Error("Anthropic Messages API stream error: 400; {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"fallbacks: Extra inputs are not permitted\"}}");
      }
      return "mock-sse";
    },
    parseSse: () => successfulEnd("msg_fallback_unsupported"),
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(fableModel(), context(), { reasoning: "medium" }));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(requestCount, 2);
  assert.ok(!("fallbacks" in buildRequestCalls[1].payload));

  // Second turn: the latch skips fallbacks without a wasted request.
  const second = await collectEvents(streamSimple(fableModel(), context(), { reasoning: "medium" }));
  assert.equal(second.at(-1)?.type, "done");
  assert.equal(requestCount, 3);
  assert.ok(!("fallbacks" in buildRequestCalls[2].payload));
});
