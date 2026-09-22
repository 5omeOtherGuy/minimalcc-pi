import assert from "node:assert/strict";
import test from "node:test";

import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

import { type AnthropicSseEvent } from "../src/anthropic-sse.ts";
import { SERVER_SIDE_FALLBACK_BETA } from "../src/constants.ts";
import { CLAUDE_SUBSCRIPTION_NATIVE_API_ID, CLAUDE_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../src/models.ts";
import { contextToPayload, nativeCompat, resetServerSideFallbackSupportForTests } from "../src/native-payload.ts";
import { buildNativeMessagesRequest, type NativeMessagesRequest, type NativeMessagesRequestInput } from "../src/native-request.ts";
import { createNativeStreamSimple } from "../src/native-stream-simple.ts";

// Claude Opus 5.5 differs from Claude Opus 5 on the request surface:
//   - thinking is always on: `thinking: {type: "disabled"}` and
//     `{type: "enabled", budget_tokens}` both 400 at every effort level;
//   - forced `tool_choice` (`any` / `tool`) 400s;
//   - broader safety classifiers (`cyber`, `bio`, `reasoning_extraction`)
//     can end a turn with `stop_reason: "refusal"`;
//   - thinking blocks are bound to the producing model and conversation.
// Because thinking cannot be turned off, Pi `off` is not offered: omitting
// `thinking` would silently run at the server's default effort (`medium`) while
// the UI claimed "thinking off". No server-side refusal fallback is configured.

const OPUS_5_5 = "claude-opus-5-5";
const FAKE_TOKEN = "fake-native-opus-5-5-oauth-token";
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORTS = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } as const;

function registeredModel(id: string): Model<Api> {
  const config = MODELS.find((entry) => entry.id === id);
  assert.ok(config, `${id} must be registered`);
  return {
    ...config,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
  } as Model<Api>;
}

function context(overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    ...overrides,
  };
}

function assistantTurn(model: string, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function createHarness(parserEvents: AnthropicSseEvent[]) {
  const buildRequestCalls: NativeMessagesRequestInput[] = [];
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return {
        url: "mock://anthropic/messages",
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        body: input.payload,
      } satisfies NativeMessagesRequest;
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

test.beforeEach(() => resetServerSideFallbackSupportForTests());

test("registers claude-opus-5-5 as always-adaptive without a refusal fallback", () => {
  const model = registeredModel(OPUS_5_5);
  assert.equal(model.name, "Claude Opus 5.5 (Claude Code subscription)");
  assert.equal(model.api, CLAUDE_SUBSCRIPTION_NATIVE_API_ID);
  assert.deepEqual(nativeCompat(model), { forceAdaptiveThinking: true });
  // Listed directly after its predecessor so model pickers keep the Opus line together.
  const ids = MODELS.map((entry) => entry.id);
  assert.equal(ids.indexOf(OPUS_5_5), ids.indexOf("claude-opus-5") + 1);
});

test("claude-opus-5-5 hides Pi off and clamps a persisted off to minimal", () => {
  const model = registeredModel(OPUS_5_5);
  assert.deepEqual(getSupportedThinkingLevels(model), [...PI_LEVELS]);
  assert.equal(clampThinkingLevel(model, "off"), "minimal");
});

test("claude-opus-5-5 never sends disabled or budget thinking at any Pi level", () => {
  const model = registeredModel(OPUS_5_5);
  const thinkingBudgets = { minimal: 2048, low: 4096, medium: 8192, high: 16384, xhigh: 32768 };
  for (const reasoning of [undefined, ...PI_LEVELS]) {
    // Pi compaction clamps maxTokens; that must not push the payload onto the
    // manual-budget path either.
    for (const maxTokens of [undefined, 8192]) {
      const label = `reasoning=${reasoning ?? "off"} maxTokens=${maxTokens ?? "default"}`;
      const payload = contextToPayload(model, context(), { reasoning, maxTokens, thinkingBudgets, temperature: 0.2 });
      const thinking = payload.thinking as { type?: string; budget_tokens?: number } | undefined;
      // Every request, including one without a Pi level, carries explicit
      // adaptive thinking and an explicit effort: the server default never applies.
      assert.deepEqual(thinking, { type: "adaptive", display: "summarized" }, label);
      assert.deepEqual(payload.output_config, { effort: reasoning === undefined ? "low" : EFFORTS[reasoning] }, label);
      assert.notEqual(thinking?.type, "disabled", label);
      assert.notEqual(thinking?.type, "enabled", label);
      assert.ok(!("temperature" in payload), label);
    }
  }
});

test("claude-opus-5-5 sends tools without a forced tool_choice", () => {
  const payload = contextToPayload(registeredModel(OPUS_5_5), context({
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } as never }],
  }), { reasoning: "high" });
  assert.equal((payload.tools as unknown[]).length, 1);
  assert.ok(!("tool_choice" in payload));
});

test("claude-opus-5-5 requests carry no fallbacks parameter and no fallback beta", () => {
  const payload = contextToPayload(registeredModel(OPUS_5_5), context(), { reasoning: "medium" });
  assert.ok(!("fallbacks" in payload));
  const request = buildNativeMessagesRequest({ accessToken: FAKE_TOKEN, payload });
  assert.ok(!request.headers["anthropic-beta"].split(",").includes(SERVER_SIDE_FALLBACK_BETA));
  assert.ok(!("x-api-key" in request.headers));
});

for (const category of ["bio", "reasoning_extraction"]) {
  test(`claude-opus-5-5 terminal ${category} refusal names the category`, async () => {
    const { streamSimple } = createHarness([
      { type: "messageStart", responseId: `msg_opus_5_5_${category}`, model: OPUS_5_5 },
      { type: "messageDelta", stopReason: "refusal", stopDetailsCategory: category, usage: { output_tokens: 0 } },
      { type: "messageStop", stopReason: "refusal" },
    ]);

    const events = await collectEvents(streamSimple(registeredModel(OPUS_5_5), context(), { reasoning: "medium" }));
    const last = events.at(-1);
    assert.equal(last?.type, "error");
    const message = (last as Extract<AssistantMessageEvent, { type: "error" }>).error.errorMessage ?? "";
    assert.match(message, /stop_reason=refusal/);
    assert.match(message, new RegExp(`category: ${category}`));
    assert.doesNotMatch(message, /server-side fallback/);
    // The user is already on an Opus model; the hint must not tell them to switch to one.
    assert.doesNotMatch(message, /switch to an Opus model/);
  });
}

test("claude-opus-5-5 replays only its own signed thinking and keeps other models' reasoning as text", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_opus_5_5_replay", model: OPUS_5_5 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(registeredModel(OPUS_5_5), {
    messages: [
      { role: "user", content: "first", timestamp: 0 },
      assistantTurn("claude-opus-5", [
        { type: "thinking", thinking: "opus 5 reasoning", thinkingSignature: "opus-5-signature" },
        { type: "text", text: "from opus 5" },
      ]),
      { role: "user", content: "second", timestamp: 0 },
      assistantTurn(OPUS_5_5, [
        // Progress-update thinking blocks can be empty under display "omitted";
        // they must still replay verbatim with their signature.
        { type: "thinking", thinking: "", thinkingSignature: "opus-5-5-progress-signature" },
        { type: "thinking", thinking: "opus 5.5 reasoning", thinkingSignature: "opus-5-5-signature" },
        { type: "text", text: "from opus 5.5" },
      ]),
      { role: "user", content: "third", timestamp: 0 },
    ],
  }, { reasoning: "medium" }));

  assert.equal(events.at(-1)?.type, "done");
  const messages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "opus 5 reasoning" },
      { type: "text", text: "from opus 5" },
    ],
  });
  assert.deepEqual(messages[3], {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "opus-5-5-progress-signature" },
      { type: "thinking", thinking: "opus 5.5 reasoning", signature: "opus-5-5-signature" },
      { type: "text", text: "from opus 5.5" },
    ],
  });
});
