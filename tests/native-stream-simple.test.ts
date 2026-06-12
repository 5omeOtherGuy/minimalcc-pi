import assert from "node:assert/strict";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import type { AnthropicSseEvent } from "../src/anthropic-sse.ts";
import {
  CLAUDE_CODE_IDENTITY,
  MESSAGE_BATCHES_300K_OUTPUT_BETA,
  MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
} from "../src/constants.ts";
import { getNativeCacheDiagnosticsSnapshot, resetNativeCacheDiagnostics } from "../src/native-cache-diagnostics.ts";
import { ANTHROPIC_MESSAGES_URL, buildNativeMessagesRequest, type NativeMessagesRequest, type NativeMessagesRequestInput } from "../src/native-request.ts";
import {
  DEFAULT_RESPONSE_START_TIMEOUT_MS,
  DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS,
  createNativeStreamSimple,
  streamNativeMessagesSse,
  streamNativeMessagesSseEvents,
} from "../src/native-stream-simple.ts";
import { resetNativeFetchDispatcherForTests } from "../src/native-fetch-dispatcher.ts";
import { getNativeUsageTelemetrySnapshot, resetNativeUsageTelemetry } from "../src/native-usage-telemetry.ts";
import {
  TOOL_RESULT_CLEARED_PLACEHOLDER,
  disabledMicrocompactionConfig,
  type NativeMicrocompactionConfig,
} from "../src/native-microcompaction.ts";
import {
  getNativeMicrocompactionTelemetrySnapshot,
  resetNativeMicrocompactionTelemetry,
} from "../src/native-microcompaction-telemetry.ts";
import { getNativeToolCallDiagnosticsSnapshot, resetNativeToolCallDiagnostics } from "../src/native-tool-call-diagnostics.ts";

const FAKE_TOKEN = "fake-native-stream-oauth-token";
const REFRESHED_FAKE_TOKEN = "fake-native-stream-refreshed-oauth-token";
const DUMMY_PI_API_KEY = "dummy-pi-api-key-must-be-ignored";
const PROVIDER_ID = "claude-subscription";
const SUBSCRIPTION_NATIVE_API_ID = "claude-subscription-native";
const SHARED_ANTHROPIC_API_ID = "anthropic-messages";
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" };

type BuildRequestCall = NativeMessagesRequestInput;
type StreamRequestCall = { request: NativeMessagesRequest; signal?: AbortSignal; knownSecrets?: readonly string[] };
type ParseCall = { sse: string; knownSecrets?: readonly string[] };

function model(id = "claude-sonnet-4-6", overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
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
  // Default mock URL: defense-in-depth so tests that go through a mocked
  // streamRequest never accidentally reach api.anthropic.com if the mock is
  // misconfigured. Tests that intentionally exercise the real fetch path must
  // opt in via requestForMockedAnthropicFetch().
  return {
    url: "mock://anthropic/messages",
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    body: input.payload,
  };
}

// Use only when the test mocks globalThis.fetch and exercises the real
// fetchNativeMessagesResponse path. Sets the canonical Anthropic URL so the
// production URL invariant is satisfied; the mocked fetch ignores the URL.
function requestForMockedAnthropicFetch(input: NativeMessagesRequestInput): NativeMessagesRequest {
  return { ...requestFrom(input), url: ANTHROPIC_MESSAGES_URL };
}

function createHarness(parserEvents: AnthropicSseEvent[]) {
  const buildRequestCalls: BuildRequestCall[] = [];
  const streamRequestCalls: StreamRequestCall[] = [];
  const parseCalls: ParseCall[] = [];

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async (request, options = {}) => {
      streamRequestCalls.push({
        request,
        signal: options.signal,
        knownSecrets: options.knownSecrets,
      });
      return "mock-sse";
    },
    parseSse: (sse, options = {}) => {
      parseCalls.push({ sse, knownSecrets: options.knownSecrets });
      return parserEvents;
    },
    now: () => 1234567890,
  });

  return { streamSimple, buildRequestCalls, streamRequestCalls, parseCalls };
}

function successfulTextEvents(responseId = "msg_ok"): AnthropicSseEvent[] {
  return [
    { type: "messageStart", responseId, model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ];
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createRealRequestHarness(parserEvents: AnthropicSseEvent[]) {
  const requests: NativeMessagesRequest[] = [];

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      const request = buildNativeMessagesRequest(input);
      requests.push(request);
      return request;
    },
    streamRequest: async () => "mock-sse",
    parseSse: () => parserEvents,
    now: () => 1234567890,
  });

  return { streamSimple, requests };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type);
}

function lastErrorEvent(events: readonly AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "error" }> {
  const last = events.at(-1);
  assert.ok(last && last.type === "error", "last event should be an error");
  return last;
}


// Post-stream telemetry (request fingerprint, usage, cache diagnostics) is
// recorded on a setImmediate after the done event so the expensive hash work
// never delays Pi's continuation. setImmediate callbacks run FIFO, so one
// drain hop scheduled after the streams completed guarantees their deferred
// telemetry has been recorded.
async function drainDeferredTelemetry(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("rejectsNonSubscriptionProvidersBeforeLoadingCredentials", async () => {
  for (const provider of ["anthropic", "custom-anthropic", "meridian", "openai-codex"]) {
    let loadCredentialsCalls = 0;
    let buildRequestCalls = 0;
    let streamRequestCalls = 0;

    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => {
        loadCredentialsCalls++;
        return FAKE_TOKEN;
      },
      buildRequest: (input) => {
        buildRequestCalls++;
        return requestFrom(input);
      },
      streamRequest: async () => {
        streamRequestCalls++;
        return "mock-sse";
      },
      parseSse: () => [],
      now: () => 1234567890,
    });

    const events = await collectEvents(streamSimple(
      model("claude-sonnet-4-6", {
        provider,
        api: provider === "openai-codex" ? "openai-responses" : SHARED_ANTHROPIC_API_ID,
      }),
      context(),
      { apiKey: DUMMY_PI_API_KEY },
    ));

    assert.equal(loadCredentialsCalls, 0, `${provider}: provider guard should run before OAuth credential loading`);
    assert.equal(buildRequestCalls, 0, `${provider}: rejected providers should not build native requests`);
    assert.equal(streamRequestCalls, 0, `${provider}: rejected providers should not reach transport`);
    assert.deepEqual(eventTypes(events), ["start", "error"], provider);
    assert.equal(events[1].type, "error", provider);
    assert.equal(events[1].reason, "error", provider);
    assert.match(events[1].error.errorMessage ?? "", /claude-subscription/, provider);
    assert.ok((events[1].error.errorMessage ?? "").includes(provider), provider);
    assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN), provider);
    assert.ok(!(events[1].error.errorMessage ?? "").includes(`Bearer ${FAKE_TOKEN}`), provider);
    assert.ok(!(events[1].error.errorMessage ?? "").includes(DUMMY_PI_API_KEY), provider);
  }
});

test("streamsTextStartDeltaEndDone", async () => {
  const { streamSimple, buildRequestCalls, streamRequestCalls, parseCalls } = createHarness([
    { type: "messageStart", responseId: "msg_text", model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "Hello" },
    { type: "textDelta", index: 0, text: " world" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 2 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model(), context(), {
    apiKey: DUMMY_PI_API_KEY,
    maxTokens: 99,
  }));

  assert.deepEqual(eventTypes(events), [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.equal(events[2].type, "text_delta");
  assert.equal(events[2].delta, "Hello");
  assert.equal(events[3].type, "text_delta");
  assert.equal(events[3].delta, " world");
  assert.equal(events[4].type, "text_end");
  assert.equal(events[4].content, "Hello world");
  assert.equal(events[5].type, "done");
  assert.equal(events[5].reason, "stop");
  assert.deepEqual(events[5].message.content, [{ type: "text", text: "Hello world" }]);
  assert.equal(events[5].message.responseId, "msg_text");
  assert.equal(events[5].message.responseModel, "claude-sonnet-4-6");
  assert.equal(events[5].message.timestamp, 1234567890);

  assert.equal(buildRequestCalls.length, 1);
  assert.equal(buildRequestCalls[0].accessToken, FAKE_TOKEN);
  assert.notEqual(buildRequestCalls[0].accessToken, DUMMY_PI_API_KEY);
  assert.equal(buildRequestCalls[0].payload.model, "claude-sonnet-4-6");
  assert.equal(buildRequestCalls[0].payload.max_tokens, 99);
  assert.equal(buildRequestCalls[0].payload.stream, true);
  assert.equal(buildRequestCalls[0].payload.system, "Pi system prompt");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{ role: "user", content: "hello" }]);

  assert.equal(streamRequestCalls.length, 1);
  assert.equal(streamRequestCalls[0].request.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.deepEqual(streamRequestCalls[0].knownSecrets, [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`]);
  assert.deepEqual(parseCalls, [{ sse: "mock-sse", knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`] }]);
});

test("registeredSoftCapOpusModelSendsNativeOpusId", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_opus_300k", model: "claude-opus-4-7" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model("claude-opus-4-7-300k", {
    contextWindow: 300000,
    maxTokens: 128000,
    compat: { forceAdaptiveThinking: true, nativeModelId: "claude-opus-4-7" } as any,
  }), context(), { apiKey: DUMMY_PI_API_KEY }));

  assert.equal(buildRequestCalls.length, 1);
  assert.equal(buildRequestCalls[0].payload.model, "claude-opus-4-7");
  const finalEvent = events.at(-1);
  assert.equal(finalEvent?.type, "done");
  assert.equal(finalEvent?.type === "done" ? finalEvent.message.model : undefined, "claude-opus-4-7-300k");
  assert.equal(finalEvent?.type === "done" ? finalEvent.message.responseModel : undefined, "claude-opus-4-7");
});

test("undefinedSystemPromptBuildsIdentityOnlySystemBlock", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_no_system"));

  const events = await collectEvents(streamSimple(model(), {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(requests[0].body.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: EPHEMERAL_CACHE_CONTROL },
  ]);
});

test("nativeRequestPipelineAddsPromptCachingAnchors", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_prompt_cache"));

  const events = await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [
      {
        name: "read",
        description: "Read files",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "bash",
        description: "Run shell commands",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(requests[0].body.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: EPHEMERAL_CACHE_CONTROL },
    { type: "text", text: "Pi system prompt", cache_control: EPHEMERAL_CACHE_CONTROL },
  ]);
  assert.deepEqual(requests[0].body.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello", cache_control: EPHEMERAL_CACHE_CONTROL }],
  }]);
  assert.deepEqual(requests[0].body.tools, [
    {
      name: "read",
      description: "Read files",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "bash",
      description: "Run shell commands",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      cache_control: EPHEMERAL_CACHE_CONTROL,
    },
  ]);
  // Parity with Pi's built-in Anthropic provider: omit `tool_choice` so Anthropic's `auto` default
  // allows parallel tool calls (Roadmap 3.1 reversed 2026-06-08). Same-file edit/write races are
  // already prevented by Pi's harness-owned per-realpath file-mutation queue regardless of provider.
  // Revisit if real parallel-tool-call races appear in practice.
  assert.ok(!("tool_choice" in requests[0].body), "provider omits tool_choice for parallel-tool-use parity");
  assert.ok(!JSON.stringify(requests[0].body.tools).includes("eager_input_streaming"));
  assert.ok(!requests[0].headers["anthropic-beta"].includes("fine-grained-tool-streaming-2025-05-14"));
});

test("messageBatches300kOutputCompatDoesNotChangeStreamingMessagesHeadersOrCaps", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_batch_output_compat"));

  const events = await collectEvents(streamSimple(model("claude-opus-4-8", {
    maxTokens: 128000,
    compat: {
      forceAdaptiveThinking: true,
      messageBatchesOutputBeta: MESSAGE_BATCHES_300K_OUTPUT_BETA,
      messageBatchesOutputMaxTokens: MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
    } as never,
  }), context(), { maxTokens: 128000 }));

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(requests[0].body.max_tokens, 128000);
  assert.ok(!requests[0].headers["anthropic-beta"].includes(MESSAGE_BATCHES_300K_OUTPUT_BETA));
});

test("ignoresLegacyFineGrainedToolStreamingCompatAndUsesStandardToolShape", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_standard_tool_shape"));

  const events = await collectEvents(streamSimple(model("claude-sonnet-4-6", {
    compat: { supportsEagerToolInputStreaming: false } as never,
  }), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [{
      name: "bash",
      description: "Run shell commands",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(requests[0].body.tools, [{
    name: "bash",
    description: "Run shell commands",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    cache_control: EPHEMERAL_CACHE_CONTROL,
  }]);
  assert.ok(!JSON.stringify(requests[0].body.tools).includes("eager_input_streaming"));
  assert.ok(!requests[0].headers["anthropic-beta"].includes("fine-grained-tool-streaming-2025-05-14"));
});

test("stripsPiDocRoutingLinesInFullNativeRequestPipeline", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_doc_prompt"));
  const systemPrompt = [
    "You help users with code.",
    "- When asked about: extensions, read docs",
    "- When working on pi topics, read docs",
    "- Always read pi .md files completely",
    "Be concise.",
  ].join("\n");

  const events = await collectEvents(streamSimple(model(), {
    systemPrompt,
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }));

  assert.equal(events.at(-1)?.type, "done");
  const system = requests[0].body.system as Array<{ type: string; text: string }>;
  assert.equal(system.length, 2);
  assert.equal(system[0].text, CLAUDE_CODE_IDENTITY);
  assert.ok(!system[1].text.includes("- When asked about:"));
  assert.ok(!system[1].text.includes("- When working on pi topics"));
  assert.ok(!system[1].text.includes("- Always read pi .md files"));
  assert.ok(system[1].text.includes("You help users with code."));
  assert.ok(system[1].text.includes("Be concise."));
});

test("mixedTextAndImageUserMessageBuildsArrayContent", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_user_image"));
  const imageContext: Context = {
    systemPrompt: "Pi system prompt",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What do you see?" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
      timestamp: 0,
    }],
  };

  const events = await collectEvents(streamSimple(model(), imageContext));

  assert.equal(events.at(-1)?.type, "done");
  const messages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 1);
  assert.ok(Array.isArray(messages[0].content), "image-containing user message must produce array content");
  const content = messages[0].content as Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>;
  assert.deepEqual(content[0], { type: "text", text: "What do you see?" });
  assert.equal(content[1].type, "image");
  assert.equal(content[1].source?.media_type, "image/png");
  assert.equal(content[1].source?.data, "iVBORw0KGgo=");
});

test("dropsEmptyAndWhitespaceOnlyUserMessages", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_empty_user"));

  const events = await collectEvents(streamSimple(model(), {
    messages: [
      { role: "user", content: "   ", timestamp: 0 },
      { role: "user", content: "", timestamp: 1 },
      { role: "user", content: "real message", timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "  " }], timestamp: 3 },
    ],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    { role: "user", content: "real message" },
  ]);
});

test("toolResultWithImageBuildsArrayContent", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_tool_result_image"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "toolu_screenshot", name: "screenshot", arguments: {} }],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "toolu_screenshot",
    toolName: "screenshot",
    content: [
      { type: "text", text: "Screenshot captured." },
      { type: "image", mimeType: "image/jpeg", data: "/9j/fakeJpegData" },
    ],
    isError: false,
    timestamp: 1,
  };

  const events = await collectEvents(streamSimple(model(), { messages: [assistantMessage, toolResult] }));

  assert.equal(events.at(-1)?.type, "done");
  const messages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "user");
  const outerContent = messages[1].content as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
  const block = outerContent[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_screenshot");
  assert.ok(Array.isArray(block.content), "tool result with image must have array content");
  const innerContent = block.content as Array<{ type: string; source?: { media_type: string; data: string } }>;
  assert.equal(innerContent[0].type, "text");
  assert.equal(innerContent[1].type, "image");
  assert.equal(innerContent[1].source?.media_type, "image/jpeg");
  assert.equal(innerContent[1].source?.data, "/9j/fakeJpegData");
});

test("coalesces consecutive tool results into one Anthropic user message", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_coalesced_tool_results"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "toolu_one", name: "read", arguments: { path: "one" } },
      { type: "toolCall", id: "toolu_two", name: "read", arguments: { path: "two" } },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };

  const events = await collectEvents(streamSimple(model(), {
    messages: [
      assistantMessage,
      {
        role: "toolResult",
        toolCallId: "toolu_one",
        toolName: "read",
        content: [{ type: "text", text: "one" }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_two",
        toolName: "read",
        content: [{ type: "text", text: "two" }],
        isError: true,
        timestamp: 1,
      },
    ],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_one", name: "read", input: { path: "one" } },
        { type: "tool_use", id: "toolu_two", name: "read", input: { path: "two" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_one", content: "one", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_two", content: "two", is_error: true },
      ],
    },
  ]);
});

test("maps invalid tool call ids consistently for Anthropic replay", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_mapped_tool_ids"));
  const invalidToolCallId = "call_ljGwOURkQtR6X7yTpGBjRNqU|fc_03a47985c5cebf750169fba149b084819186d00d4f5ab9a14a";
  const mappedToolCallId = "call_ljGwOURkQtR6X7yTpGBjRNqU_fc_03a47985c5cebf750169fba149b084819186d00d4f5ab9a14a";
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: invalidToolCallId, name: "bash", arguments: { command: "git status" } }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: invalidToolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "clean" }],
    isError: false,
    timestamp: 1,
  };

  const events = await collectEvents(streamSimple(model(), {
    messages: [assistantMessage, toolResult],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: mappedToolCallId, name: "bash", input: { command: "git status" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: mappedToolCallId, content: "clean", is_error: false }],
    },
  ]);
});

test("dropsReplayedToolCallsWhenImmediateToolResultsAreIncomplete", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_incomplete_tool_replay"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect two files." },
      { type: "toolCall", id: "toolu_one", name: "read", arguments: { path: "one" } },
      { type: "toolCall", id: "toolu_two", name: "read", arguments: { path: "two" } },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const partialToolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "toolu_one",
    toolName: "read",
    content: [{ type: "text", text: "one" }],
    isError: false,
    timestamp: 1,
  };

  const events = await collectEvents(streamSimple(model(), {
    messages: [
      assistantMessage,
      partialToolResult,
      { role: "user", content: "resume please", timestamp: 2 },
    ],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    { role: "assistant", content: [{ type: "text", text: "I will inspect two files." }] },
    { role: "user", content: "resume please" },
  ]);
  const replayedPayload = JSON.stringify(buildRequestCalls[0].payload.messages);
  assert.ok(!replayedPayload.includes("tool_use"), "incomplete replay must not send Anthropic tool_use blocks");
  assert.ok(!replayedPayload.includes("tool_result"), "incomplete replay must not send orphan tool_result blocks");
});

test("converts non-Claude-subscription thinking text to text during Anthropic replay", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_foreign_thinking"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "foreign-redacted-payload", redacted: true },
      { type: "thinking", thinking: "foreign provider reasoning", thinkingSignature: "foreign-signature" },
      { type: "text", text: "I'll inspect the repo." },
      { type: "toolCall", id: "call_invalid|foreign", name: "bash", arguments: { command: "git status" } },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };

  const events = await collectEvents(streamSimple(model(), {
    messages: [assistantMessage],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [
      { type: "text", text: "foreign provider reasoning" },
      { type: "text", text: "I'll inspect the repo." },
    ],
  }]);
});

test("converts different-model Claude-subscription thinking text to text during Anthropic replay", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_different_model_thinking"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "same provider different model reasoning", thinkingSignature: "sonnet-signature" },
      { type: "text", text: "I'll continue." },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
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

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), {
    messages: [assistantMessage],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [
      { type: "text", text: "same provider different model reasoning" },
      { type: "text", text: "I'll continue." },
    ],
  }]);
});

test("replays same-model signed thinking byte-for-byte without sanitizing or trim-filtering", async () => {
  // Anthropic computes the thinking signature over the EXACT original characters
  // and rejects any change to a thinking/redacted_thinking block in the latest
  // assistant message with a 400 ("blocks ... cannot be modified"). The provider
  // must therefore replay signed thinking verbatim for the same native model:
  // no surrogate sanitizing, no trimming, and no dropping of signed-but-empty
  // blocks (removing a block also mutates the latest assistant message).
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_same_model_thinking"));
  // Exercise three things sanitizeSurrogates()/trim() would have corrupted:
  //  - a valid astral character (emoji = a UTF-16 surrogate PAIR): sanitize
  //    rewrites every surrogate code unit, so it would corrupt valid emoji too;
  //  - a lone/unpaired high surrogate: sanitize would rewrite \uD83D to \uFFFD;
  //  - leading/trailing whitespace: trimming would drop it.
  // Any of these changes the exact characters the signature was computed over.
  const signedThinkingText = "  reasoning with emoji \u{1F600} and a lone surrogate \uD83D and trailing space  ";
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: signedThinkingText, thinkingSignature: "opus-signature-1" },
      { type: "thinking", thinking: "", thinkingSignature: "opus-signature-empty" },
      { type: "thinking", thinking: "  \n\t  ", thinkingSignature: "opus-signature-whitespace" },
      { type: "text", text: "I'll continue." },
      { type: "toolCall", id: "toolu_same_model", name: "read", arguments: { path: "one" } },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "toolu_same_model",
    toolName: "read",
    content: [{ type: "text", text: "one" }],
    isError: false,
    timestamp: 1,
  };

  const events = await collectEvents(streamSimple(model(), {
    messages: [assistantMessage, toolResult],
  }));

  assert.equal(events.at(-1)?.type, "done");
  const [replayedAssistant] = buildRequestCalls[0].payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(replayedAssistant.content, [
    { type: "thinking", thinking: signedThinkingText, signature: "opus-signature-1" },
    { type: "thinking", thinking: "", signature: "opus-signature-empty" },
    { type: "thinking", thinking: "  \n\t  ", signature: "opus-signature-whitespace" },
    { type: "text", text: "I'll continue." },
    { type: "tool_use", id: "toolu_same_model", name: "read", input: { path: "one" } },
  ]);
  // The replayed thinking is the exact stored string value, never the
  // surrogate-replaced form and never trimmed away.
  assert.equal(replayedAssistant.content[0]?.thinking, signedThinkingText);
  assert.ok(!String(replayedAssistant.content[0]?.thinking).includes("\uFFFD"), "signed thinking must not be surrogate-sanitized");

  // Prove the value survives the real serialization path the request takes
  // (JSON.stringify -> UTF-8 encode -> decode -> parse). JSON escapes the lone
  // surrogate as \udXXX, so the wire bytes differ, but the parsed code-unit
  // value Anthropic sees must equal the original the signature was computed over.
  const wireJson = JSON.stringify(buildRequestCalls[0].payload);
  const roundTripped = JSON.parse(new TextDecoder().decode(new TextEncoder().encode(wireJson))) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.equal(roundTripped.messages[0]?.content[0]?.thinking, signedThinkingText);
  assert.equal(roundTripped.messages[0]?.content[2]?.thinking, "  \n\t  ");
  assert.ok(!wireJson.includes("\uFFFD"), "serialized request body must not contain surrogate-replacement chars");
});

test("replays same-model redacted thinking verbatim as redacted_thinking", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_same_model_redacted"));
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "encrypted-redacted-payload", redacted: true },
      { type: "text", text: "Proceeding." },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
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

  const events = await collectEvents(streamSimple(model(), {
    messages: [assistantMessage],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [
      { type: "redacted_thinking", data: "encrypted-redacted-payload" },
      { type: "text", text: "Proceeding." },
    ],
  }]);
});

test("skips errored and aborted assistant messages during replay", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_skip_bad_assistant"));

  const events = await collectEvents(streamSimple(model(), {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "partial errored output" }],
        api: SUBSCRIPTION_NATIVE_API_ID,
        provider: PROVIDER_ID,
        model: "claude-sonnet-4-6",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial aborted output" }],
        api: SUBSCRIPTION_NATIVE_API_ID,
        provider: PROVIDER_ID,
        model: "claude-sonnet-4-6",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "aborted",
        timestamp: 1,
      },
      { role: "user", content: "please continue", timestamp: 2 },
    ],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    { role: "user", content: "please continue" },
  ]);
});

test("cacheRetentionNoneDisablesPromptCacheAnchors", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_no_cache"));

  const events = await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
  }, { cacheRetention: "none" }));

  assert.equal(events.at(-1)?.type, "done");
  assert.ok(!JSON.stringify(requests[0].body).includes("cache_control"));
});

test("cacheRetentionLongUsesOneHourCacheControl", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_long_cache"));

  const events = await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { cacheRetention: "long" }));

  assert.equal(events.at(-1)?.type, "done");
  assert.match(JSON.stringify(requests[0].body), /"ttl":"1h"/);
});

test("cacheRetentionLongFallsBackToShortWhenModelCompatDisablesLongCache", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_short_cache_compat"));

  const events = await collectEvents(streamSimple(model("claude-sonnet-4-6", {
    compat: { supportsLongCacheRetention: false } as never,
  }), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { cacheRetention: "long" }));

  assert.equal(events.at(-1)?.type, "done");
  assert.ok(JSON.stringify(requests[0].body).includes("cache_control"));
  assert.ok(!JSON.stringify(requests[0].body).includes("\"ttl\""));
});

test("piCacheRetentionEnvCanRequestLongCacheByDefault", async () => {
  const previous = process.env.PI_CACHE_RETENTION;
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_env_long_cache"));

  try {
    process.env.PI_CACHE_RETENTION = "long";
    const events = await collectEvents(streamSimple(model(), {
      systemPrompt: "Pi system prompt",
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }));

    assert.equal(events.at(-1)?.type, "done");
    assert.match(JSON.stringify(requests[0].body), /"ttl":"1h"/);
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
  }
});

test("uses shifted adaptive effort mapping for adaptive-only Opus models", async () => {
  const expectedEfforts = new Map([
    ["minimal", "low"],
    ["low", "medium"],
    ["medium", "high"],
    ["high", "xhigh"],
    ["xhigh", "max"],
  ] as const);
  const adaptiveThinkingLevelMap = { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" };
  const cases = [
    { modelId: "claude-opus-4-7", responseModelId: "claude-opus-4-7", compat: undefined },
    { modelId: "claude-opus-4-7-300k", responseModelId: "claude-opus-4-7", compat: { forceAdaptiveThinking: true, nativeModelId: "claude-opus-4-7" } as never },
    { modelId: "claude-opus-4-8", responseModelId: "claude-opus-4-8", compat: undefined },
  ] as const;

  for (const testCase of cases) {
    for (const [reasoning, effort] of expectedEfforts) {
      const { streamSimple, buildRequestCalls } = createHarness([
        { type: "messageStart", responseId: `msg_${testCase.modelId}_${reasoning}`, model: testCase.responseModelId },
        { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
        { type: "messageStop", stopReason: "end_turn" },
      ]);

      await collectEvents(streamSimple(
        model(testCase.modelId, {
          compat: testCase.compat,
          thinkingLevelMap: adaptiveThinkingLevelMap,
        }),
        context(),
        { reasoning, temperature: 0.3 },
      ));

      assert.equal(buildRequestCalls.length, 1, `${testCase.modelId} ${reasoning}`);
      assert.deepEqual(buildRequestCalls[0].payload.thinking, { type: "adaptive", display: "summarized" }, `${testCase.modelId} ${reasoning}`);
      assert.deepEqual(buildRequestCalls[0].payload.output_config, { effort }, `${testCase.modelId} ${reasoning}`);
      assert.ok(!("temperature" in buildRequestCalls[0].payload), `${testCase.modelId} ${reasoning}`);
    }
  }
});

test("omits temperature for adaptive-only Opus models even when thinking is disabled", async () => {
  for (const modelId of ["claude-opus-4-7", "claude-opus-4-8"] as const) {
    const { streamSimple, buildRequestCalls } = createHarness([
      { type: "messageStart", responseId: `msg_${modelId}_no_thinking`, model: modelId },
      { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
      { type: "messageStop", stopReason: "end_turn" },
    ]);

    await collectEvents(streamSimple(
      model(modelId, {
        thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
      }),
      context(),
      { temperature: 0.3 },
    ));

    assert.ok(!("thinking" in buildRequestCalls[0].payload), modelId);
    assert.ok(!("output_config" in buildRequestCalls[0].payload), modelId);
    assert.ok(!("temperature" in buildRequestCalls[0].payload), modelId);
  }
});

test("honors forceAdaptiveThinking compatibility metadata", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_adaptive_compat", model: "claude-opus-4-7" },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(
    model("claude-opus-4-7", {
      compat: { forceAdaptiveThinking: true } as never,
      thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
    }),
    context(),
    { reasoning: "xhigh", temperature: 0.3 },
  ));

  assert.deepEqual(buildRequestCalls[0].payload.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(buildRequestCalls[0].payload.output_config, { effort: "xhigh" });
  assert.ok(!("temperature" in buildRequestCalls[0].payload));
});

test("models that can avoid adaptive thinking use budget tokens and omit temperature", async () => {
  const cases = [
    { id: "claude-haiku-4-5", reasoning: "medium", budget: 10240, map: { xhigh: "xhigh" }, temperature: 0.5 },
    { id: "claude-sonnet-4-6", reasoning: "xhigh", budget: 32768, map: { xhigh: "max" }, temperature: 0.4 },
    { id: "claude-opus-4-6", reasoning: "high", budget: 20480, map: { xhigh: "max" }, temperature: 0.2 },
  ] as const;

  for (const testCase of cases) {
    const { streamSimple, buildRequestCalls } = createHarness([
      { type: "messageStart", responseId: `msg_${testCase.id}`, model: testCase.id },
      { type: "textStart", index: 0, text: "" },
      { type: "textDelta", index: 0, text: "ok" },
      { type: "contentBlockStop", index: 0 },
      { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
      { type: "messageStop", stopReason: "end_turn" },
    ]);

    const events = await collectEvents(streamSimple(
      model(testCase.id, {
        thinkingLevelMap: testCase.map,
        reasoning: true,
      }),
      context(),
      { reasoning: testCase.reasoning, temperature: testCase.temperature },
    ));

    assert.equal(events.at(-1)?.type, "done", testCase.id);
    assert.deepEqual(buildRequestCalls[0].payload.thinking, { type: "enabled", budget_tokens: testCase.budget }, testCase.id);
    assert.equal(buildRequestCalls[0].payload.output_config, undefined, testCase.id);
    assert.ok(!("temperature" in buildRequestCalls[0].payload), testCase.id);
  }
});

test("manual-budget thinking expands max_tokens to include the thinking budget when the caller clamps output (Pi compaction)", async () => {
  // Reproduces the Pi 0.75 compaction failure: compaction passes maxTokens=8192
  // through the custom provider, manual-budget thinking models (Opus/Sonnet 4.6,
  // Haiku 4.5) attach budget_tokens up to 32768, and Anthropic rejects payloads
  // where budget_tokens >= max_tokens. The fix expands Anthropic's max_tokens to
  // cover both the visible output ask and the thinking budget.
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_compaction", model: "claude-opus-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(
    model("claude-opus-4-6", { thinkingLevelMap: { xhigh: "max" }, reasoning: true, maxTokens: 64000 }),
    context(),
    { reasoning: "xhigh", maxTokens: 8192 },
  ));

  assert.equal(events.at(-1)?.type, "done");
  const payload = buildRequestCalls[0].payload as { max_tokens: number; thinking: { type: string; budget_tokens: number } };
  assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 32768 });
  // max_tokens must be strictly greater than budget_tokens (Anthropic 400 otherwise)
  // and large enough to leave the caller's visible-output ask intact.
  assert.equal(payload.max_tokens, 8192 + 32768);
  assert.ok(payload.max_tokens > payload.thinking.budget_tokens);
});

test("manual-budget thinking caps max_tokens at the model maxTokens and reduces budget when the cap forces an invalid payload", async () => {
  // If the caller's visible-output ask plus the thinking budget exceeds the
  // model maxTokens, Anthropic max_tokens is capped at model.maxTokens and the
  // thinking budget is reduced so that budget_tokens < max_tokens, preserving
  // as much of the caller's output room as possible.
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_cap", model: "claude-opus-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(
    model("claude-opus-4-6", { thinkingLevelMap: { xhigh: "max" }, reasoning: true, maxTokens: 64000 }),
    context(),
    { reasoning: "xhigh", maxTokens: 63000 },
  ));

  const payload = buildRequestCalls[0].payload as { max_tokens: number; thinking: { type: string; budget_tokens: number } };
  // 63000 + 32768 = 95768 > model cap 64000 -> max_tokens clamped to 64000.
  assert.equal(payload.max_tokens, 64000);
  // budget must be < max_tokens and >= Anthropic minimum (1024).
  assert.ok(payload.thinking.budget_tokens < payload.max_tokens);
  assert.ok(payload.thinking.budget_tokens >= 1024);
});

test("manual-budget thinking omits the thinking block when no valid budget fits under the model cap", async () => {
  // Pathological corner: the caller's visible-output ask leaves less than
  // Anthropic's 1024-token minimum thinking budget. The provider must omit
  // the thinking block entirely rather than send an invalid payload.
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_no_think", model: "claude-opus-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(
    model("claude-opus-4-6", { thinkingLevelMap: { xhigh: "max" }, reasoning: true, maxTokens: 2000 }),
    context(),
    { reasoning: "xhigh", maxTokens: 1500 },
  ));

  const payload = buildRequestCalls[0].payload as { max_tokens: number; thinking?: unknown };
  assert.equal(payload.thinking, undefined);
  // max_tokens still respects the caller's ask (clamped to the model cap).
  assert.equal(payload.max_tokens, 1500);
});

test("overlapsCredentialLoadingWithPayloadConversion", async () => {
  // Credential loading is I/O and payload conversion is CPU; the stream must
  // start both before awaiting either. The instrumented loader resolves on a
  // later macrotask, so the payload hook can only run before the credentials
  // resolve if conversion was started while the load was still in flight.
  const order: string[] = [];
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => {
      order.push("credentials-start");
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push("credentials-resolved");
      return FAKE_TOKEN;
    },
    buildRequest: requestFrom,
    streamRequest: async () => "mock-sse",
    parseSse: () => successfulTextEvents(),
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context(), {
    onPayload: (payload) => {
      order.push("payload-shaped");
      return payload;
    },
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(order, ["credentials-start", "payload-shaped", "credentials-resolved"]);
});

test("streamsToolCallStartDeltaEnd", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_tool", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_fake", name: "bash", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: '{"command":"echo' },
    { type: "toolUseInputDelta", index: 0, partialJson: ' PI_OK"}' },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 12 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), [
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ]);
  assert.equal(events[2].type, "toolcall_delta");
  assert.equal(events[2].delta, '{"command":"echo');
  assert.equal(events[3].type, "toolcall_delta");
  assert.equal(events[3].delta, ' PI_OK"}');
  assert.equal(events[4].type, "toolcall_end");
  assert.deepEqual(events[4].toolCall, {
    type: "toolCall",
    id: "toolu_fake",
    name: "bash",
    arguments: { command: "echo PI_OK" },
  });
  assert.equal(events[5].type, "done");
  assert.equal(events[5].reason, "toolUse");
  assert.deepEqual(events[5].message.content, [{
    type: "toolCall",
    id: "toolu_fake",
    name: "bash",
    arguments: { command: "echo PI_OK" },
  }]);
});

test("throttlesIncrementalToolArgumentParsingForLargeInputsButKeepsFinalArgumentsExact", async () => {
  // Incremental partial-argument parsing re-parses the whole accumulated JSON
  // fragment, which is quadratic in the final tool-input size when done on
  // every input_json_delta. Above the exact-parse bound the provider re-parses
  // on a geometric growth schedule instead; the final parse at
  // content_block_stop stays exact. Small inputs (under the bound) must keep
  // the historical parse-every-delta behavior.
  const deltaSize = 1024;
  const deltaCount = 64;
  const content = "A".repeat(deltaSize * deltaCount - '{"content":""}'.length);
  const fullJson = `{"content":"${content}"}`;
  const deltas: AnthropicSseEvent[] = [];
  for (let offset = 0; offset < fullJson.length; offset += deltaSize) {
    deltas.push({ type: "toolUseInputDelta", index: 0, partialJson: fullJson.slice(offset, offset + deltaSize) });
  }

  const parserEvents: AnthropicSseEvent[] = [
    { type: "messageStart", responseId: "msg_tool_throttle", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_throttle", name: "write", input: {} },
    ...deltas,
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 12 } },
    { type: "messageStop", stopReason: "tool_use" },
  ];

  // Yield each parser event on its own macrotask so the consumer below drains
  // every pushed assistant event before the next SSE event is applied. The
  // string-SSE path applies all events synchronously, which would let the live
  // `partial` reference advance past the state each toolcall_delta was pushed
  // with and make per-delta sampling meaningless.
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => (async function* () {
      for (const event of parserEvents) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yield event;
      }
    })(),
    now: () => 1234567890,
  });

  // `partial` is a live reference mutated in place, so argument growth must be
  // sampled as each toolcall_delta event arrives, not after collection.
  const sampledArgLengths: number[] = [];
  let finalArguments: Record<string, unknown> | undefined;
  for await (const event of streamSimple(model(), context())) {
    if (event.type === "toolcall_delta") {
      const block = event.partial.content[0];
      assert.equal(block?.type, "toolCall");
      sampledArgLengths.push(JSON.stringify(block.arguments).length);
    } else if (event.type === "toolcall_end") {
      finalArguments = event.toolCall.arguments;
    }
  }

  assert.equal(sampledArgLengths.length, deltaCount);

  // Under the exact-parse bound (16 KiB) every delta re-parses, so the partial
  // arguments grow on each of the first 16 deltas.
  for (let index = 1; index < 16; index++) {
    assert.ok(
      sampledArgLengths[index] > sampledArgLengths[index - 1],
      `delta ${index} under the exact-parse bound should grow partial arguments`,
    );
  }

  // Above the bound, re-parsing happens only on the geometric schedule: the
  // partial arguments still advance at least twice, but far fewer times than
  // once per delta (48 deltas above the bound; growth factor 1.25 yields ~6).
  let updatesAboveBound = 0;
  for (let index = 16; index < sampledArgLengths.length; index++) {
    if (sampledArgLengths[index] > sampledArgLengths[index - 1]) updatesAboveBound += 1;
  }
  assert.ok(updatesAboveBound >= 2, "partial arguments should still advance above the bound");
  assert.ok(updatesAboveBound <= 12, `expected throttled re-parsing above the bound, got ${updatesAboveBound} updates for 48 deltas`);

  // The final arguments are parsed exactly from the complete fragment.
  assert.deepEqual(finalArguments, { content });
});

test("rawSseEndToEndPreservesTextToolTextOrderingAndNonContiguousIndices", async () => {
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_raw_order", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "pre" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lude" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "toolu_read", name: "read", input: { path: "README.md" } },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 2 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 5,
      content_block: { type: "tool_use", id: "toolu_bash", name: "bash", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 5,
      delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 5 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 9,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 9,
      delta: { type: "text_delta", text: "done" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 9 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 11 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const done = events.at(-1);

  assert.deepEqual(eventTypes(events), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.ok(done && done.type === "done");
  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content, [
    { type: "text", text: "prelude" },
    { type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "README.md" } },
    { type: "toolCall", id: "toolu_bash", name: "bash", arguments: { command: "pwd" } },
    { type: "text", text: "done" },
  ]);
});

test("rawSseEndToEndUsesLastDuplicateToolArgumentKey", async () => {
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_raw_duplicate_keys", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 4,
      content_block: { type: "tool_use", id: "toolu_dup", name: "bash", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 4,
      delta: { type: "input_json_delta", partial_json: '{"command":"first","command":"second"}' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 4 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const toolcallEnd = events.find((event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end");

  assert.ok(toolcallEnd);
  assert.deepEqual(toolcallEnd.toolCall.arguments, { command: "second" });
  assert.equal(events.at(-1)?.type, "done");
});

test("rawSseEndToEndDistinguishesEmptyDeltaEventsFromNoDeltaFinalArguments", async () => {
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_raw_empty_delta", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_no_delta", name: "read", input: { path: "README.md" } },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_empty_delta", name: "bash", input: { command: "preset" } },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const done = events.at(-1);

  assert.equal(events.filter((event) => event.type === "toolcall_delta").length, 1);
  assert.ok(done && done.type === "done");
  assert.deepEqual(done.message.content, [
    { type: "toolCall", id: "toolu_no_delta", name: "read", arguments: { path: "README.md" } },
    { type: "toolCall", id: "toolu_empty_delta", name: "bash", arguments: {} },
  ]);
});

test("rawSseEndToEndFailsClosedOnNonObjectFinalToolJson", async () => {
  for (const partialJson of ["[]", "42"]) {
    const rawSse = [
      sseFrame("message_start", {
        type: "message_start",
        message: { id: "msg_raw_non_object", model: "claude-sonnet-4-6", content: [] },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_non_object", name: "bash", input: {} },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partialJson },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ].join("");
    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => FAKE_TOKEN,
      buildRequest: requestFrom,
      streamRequest: async () => rawSse,
      now: () => 1234567890,
    });

    const events = await collectEvents(streamSimple(model(), context()));
    const error = lastErrorEvent(events);

    assert.match(error.error.errorMessage ?? "", /must parse to an object/, partialJson);
    assert.equal(events.some((event) => event.type === "done"), false, partialJson);
    assert.deepEqual(error.error.content, [], partialJson);
  }
});

test("rawSseEndToEndRecoversTruncatedToolJsonAndPreservesLegacyArgumentShape", async () => {
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_raw_recover", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_recover", name: "edit", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"path":"x","oldText":"a","newText":"b","edits":[{"oldText":"c","newText":"d"' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 3 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const done = events.at(-1);

  assert.ok(done && done.type === "done");
  assert.deepEqual(done.message.content, [{
    type: "toolCall",
    id: "toolu_recover",
    name: "edit",
    arguments: {
      path: "x",
      oldText: "a",
      newText: "b",
      edits: [{ oldText: "c", newText: "d" }],
    },
  }]);
});

test("rawSseEndToEndFailsClosedOnMalformedFinalToolJson", async () => {
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_raw_bad_tool_json", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_bad", name: "edit", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/fake-secret-path","' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const error = lastErrorEvent(events);

  assert.deepEqual(eventTypes(events), ["start", "toolcall_start", "toolcall_delta", "error"]);
  assert.match(error.error.errorMessage ?? "", /Unable to parse Anthropic tool input JSON/);
  assert.ok(!(error.error.errorMessage ?? "").includes("/tmp/fake-secret-path"));
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.deepEqual(error.error.content, []);
});

test("recordsMetadataOnlyToolCallDiagnosticsFromRawSse", async () => {
  resetNativeToolCallDiagnostics();
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_tool_diag", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_secret", name: "bash", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"echo fake-secret && cat /tmp/private-file"}' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model("claude-opus-4-8"), context(), { sessionId: "session-tool-diag" }));
  const snapshot = getNativeToolCallDiagnosticsSnapshot();

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(snapshot.samples, [{
    timestamp: 1234567890,
    model: "claude-opus-4-8",
    responseId: "msg_tool_diag",
    sessionId: "session-tool-diag",
    toolName: "bash",
    argByteLength: 55,
    deltaChunkCount: 1,
    topLevelKeyCount: 1,
    finalOutcome: "clean",
  }]);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("fake-secret"));
  assert.ok(!serialized.includes("/tmp/private-file"));
  assert.ok(!serialized.includes("command"));
});

test("recordsFailedToolCallDiagnosticsWithoutLeakingMalformedArguments", async () => {
  resetNativeToolCallDiagnostics();
  const rawSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_tool_diag_fail", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_secret_fail", name: "edit", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/private-file","' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => rawSse,
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const snapshot = getNativeToolCallDiagnosticsSnapshot();

  assert.equal(events.at(-1)?.type, "error");
  assert.deepEqual(snapshot.samples, [{
    timestamp: 1234567890,
    model: "claude-sonnet-4-6",
    responseId: "msg_tool_diag_fail",
    toolName: "edit",
    argByteLength: 29,
    deltaChunkCount: 1,
    finalOutcome: "failed-unparseable",
  }]);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("/tmp/private-file"));
  assert.ok(!serialized.includes("path"));
});

test("concurrentStreamsKeepDiagnosticsAndKnownSecretsIsolated", async () => {
  await drainDeferredTelemetry();
  resetNativeUsageTelemetry();
  resetNativeCacheDiagnostics();
  resetNativeToolCallDiagnostics();

  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseStreams = deferred();

  function concurrentStream(
    token: string,
    responseId: string,
    toolCommand: string,
    usage: AnthropicSseEvent,
    started: { resolve: () => void },
  ) {
    return createNativeStreamSimple({
      loadCredentials: async () => token,
      buildRequest: requestFrom,
      streamRequest: async () => (async function* () {
        started.resolve();
        await releaseStreams.promise;
        yield { type: "messageStart", responseId, model: "claude-sonnet-4-6" } as AnthropicSseEvent;
        yield { type: "toolUseStart", index: 0, id: `toolu_${responseId}`, name: "bash", input: {} } as AnthropicSseEvent;
        yield { type: "toolUseInputDelta", index: 0, partialJson: JSON.stringify({ command: toolCommand }) } as AnthropicSseEvent;
        yield { type: "contentBlockStop", index: 0 } as AnthropicSseEvent;
        yield usage;
        yield { type: "messageStop", stopReason: "tool_use" } as AnthropicSseEvent;
      })(),
      now: () => responseId === "msg_concurrent_a" ? 111 : 222,
    });
  }

  const streamA = concurrentStream(
    "fake-concurrent-token-a",
    "msg_concurrent_a",
    "echo secret-a && cat /tmp/a",
    { type: "messageDelta", stopReason: "tool_use", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 } },
    firstStarted,
  );
  const streamB = concurrentStream(
    "fake-concurrent-token-b",
    "msg_concurrent_b",
    "echo secret-b && cat /tmp/b",
    { type: "messageDelta", stopReason: "tool_use", usage: { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 4 } },
    secondStarted,
  );

  const first = collectEvents(streamA(model(), context(), { sessionId: "session-concurrent-a" }));
  const second = collectEvents(streamB(model(), context(), { sessionId: "session-concurrent-b" }));
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  releaseStreams.resolve();
  const [eventsA, eventsB] = await Promise.all([first, second]);
  await drainDeferredTelemetry();

  assert.equal(eventsA.at(-1)?.type, "done");
  assert.equal(eventsB.at(-1)?.type, "done");

  const usageSnapshot = getNativeUsageTelemetrySnapshot();
  assert.deepEqual(
    usageSnapshot.records.map((record) => ({ responseId: record.responseId, sessionId: record.sessionId, input: record.usage.input, cacheRead: record.usage.cacheRead })),
    [
      { responseId: "msg_concurrent_a", sessionId: "session-concurrent-a", input: 10, cacheRead: 20 },
      { responseId: "msg_concurrent_b", sessionId: "session-concurrent-b", input: 30, cacheRead: 40 },
    ],
  );

  const cacheSnapshot = getNativeCacheDiagnosticsSnapshot();
  assert.equal(cacheSnapshot.events.length, 0, "first request per session must not compare against the other concurrent session");

  const toolSnapshot = getNativeToolCallDiagnosticsSnapshot();
  assert.deepEqual(
    toolSnapshot.samples.map((sample) => ({ responseId: sample.responseId, sessionId: sample.sessionId, argByteLength: sample.argByteLength, finalOutcome: sample.finalOutcome })),
    [
      { responseId: "msg_concurrent_a", sessionId: "session-concurrent-a", argByteLength: Buffer.byteLength(JSON.stringify({ command: "echo secret-a && cat /tmp/a" }), "utf8"), finalOutcome: "clean" },
      { responseId: "msg_concurrent_b", sessionId: "session-concurrent-b", argByteLength: Buffer.byteLength(JSON.stringify({ command: "echo secret-b && cat /tmp/b" }), "utf8"), finalOutcome: "clean" },
    ],
  );
  const serializedDiagnostics = JSON.stringify({ usageSnapshot, cacheSnapshot, toolSnapshot });
  assert.ok(!serializedDiagnostics.includes("secret-a"));
  assert.ok(!serializedDiagnostics.includes("secret-b"));
  assert.ok(!serializedDiagnostics.includes("/tmp/a"));
  assert.ok(!serializedDiagnostics.includes("/tmp/b"));

  const failingA = createNativeStreamSimple({
    loadCredentials: async () => "fake-isolated-token-a",
    buildRequest: requestFrom,
    streamRequest: async () => { throw new Error("auth failed fake-isolated-token-a"); },
    now: () => 1,
  });
  const failingB = createNativeStreamSimple({
    loadCredentials: async () => "fake-isolated-token-b",
    buildRequest: requestFrom,
    streamRequest: async () => { throw new Error("auth failed fake-isolated-token-b"); },
    now: () => 2,
  });
  const [failedA, failedB] = await Promise.all([
    collectEvents(failingA(model(), context(), { sessionId: "session-fail-a" })),
    collectEvents(failingB(model(), context(), { sessionId: "session-fail-b" })),
  ]);
  const errorA = lastErrorEvent(failedA).error.errorMessage ?? "";
  const errorB = lastErrorEvent(failedB).error.errorMessage ?? "";

  assert.match(errorA, /REDACTED/);
  assert.match(errorB, /REDACTED/);
  assert.ok(!errorA.includes("fake-isolated-token-a"));
  assert.ok(!errorA.includes("fake-isolated-token-b"));
  assert.ok(!errorB.includes("fake-isolated-token-a"));
  assert.ok(!errorB.includes("fake-isolated-token-b"));
});

function findToolcallEnd(
  events: AssistantMessageEvent[],
): Extract<AssistantMessageEvent, { type: "toolcall_end" }> | undefined {
  return events.find(
    (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> =>
      event.type === "toolcall_end",
  );
}

test("normalizesAnthropicEditToolArgumentsDroppingExtraEditItemKeys", async () => {
  // Valid JSON the transport cannot reject, but the stray per-item keys would
  // trip Pi's `edits.N: must not have additional properties` edit schema.
  const editArgs = JSON.stringify({
    path: "src/x.ts",
    edits: [
      { oldText: "a", newText: "b", newText_unused: "" },
      { oldText: "c", newText: "d", structuredPatch: [] },
    ],
  });
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_edit", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_edit", name: "edit", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: editArgs },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 12 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));
  const end = findToolcallEnd(events);
  assert.ok(end, "stream should emit a toolcall_end event");
  assert.deepEqual(end.toolCall, {
    type: "toolCall",
    id: "toolu_edit",
    name: "edit",
    arguments: {
      path: "src/x.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    },
  });
});

test("normalizesAnthropicEditToolArgumentsWhenEditsArriveAsAJsonString", async () => {
  // Anthropic sometimes serializes `edits` itself as a JSON string, which would
  // otherwise fail Pi with `edits.0: must be object`.
  const editArgs = JSON.stringify({
    path: "src/x.ts",
    edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
  });
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_edit_str", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_edit_str", name: "edit", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: editArgs },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 12 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));
  const end = findToolcallEnd(events);
  assert.ok(end, "stream should emit a toolcall_end event");
  assert.deepEqual(end.toolCall.arguments, {
    path: "src/x.ts",
    edits: [{ oldText: "a", newText: "b" }],
  });
});

test("normalizesAnthropicEditToolArgumentsProvidedInlineAtToolUseStart", async () => {
  // Inline (non-streamed) tool input: no input_json_delta, so the empty-payload
  // final-stop path leaves the tool_use start arguments as the executed set.
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_edit_inline", model: "claude-sonnet-4-6" },
    {
      type: "toolUseStart",
      index: 0,
      id: "toolu_edit_inline",
      name: "edit",
      input: { path: "src/x.ts", edits: [{ oldText: "a", newText: "b", newText_unused: "" }] },
    },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 3 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));
  const end = findToolcallEnd(events);
  assert.ok(end, "stream should emit a toolcall_end event");
  assert.deepEqual(end.toolCall.arguments, {
    path: "src/x.ts",
    edits: [{ oldText: "a", newText: "b" }],
  });
});

test("doesNotReshapeNonEditToolArguments", async () => {
  // The normalizer is edit-specific: a non-edit tool keeps model-provided keys
  // verbatim, including an incidental `edits`-shaped field.
  const args = JSON.stringify({
    command: "echo hi",
    edits: [{ oldText: "a", newText: "b", extra: 1 }],
  });
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_bash", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_bash", name: "bash", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: args },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 5 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));
  const end = findToolcallEnd(events);
  assert.ok(end, "stream should emit a toolcall_end event");
  assert.deepEqual(end.toolCall.arguments, {
    command: "echo hi",
    edits: [{ oldText: "a", newText: "b", extra: 1 }],
  });
});

test("mapsUsageAndCacheTokens", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_usage", model: "claude-opus-4-7" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "done" },
    { type: "contentBlockStop", index: 0 },
    {
      type: "messageDelta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), context()));
  const done = events.at(-1);

  assert.ok(done && done.type === "done", "stream should finish successfully");
  assert.deepEqual(done.message.usage, {
    input: 100,
    output: 7,
    cacheRead: 80,
    cacheWrite: 20,
    totalTokens: 207,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("refreshesOauthAndRetriesOnceWhenAnthropicRejectsFreshLocalToken", async () => {
  const credentialOptions: Array<{ forceRefresh?: boolean; previousAccessToken?: string } | undefined> = [];
  const buildRequestCalls: BuildRequestCall[] = [];
  const streamRequestCalls: StreamRequestCall[] = [];
  let streamAttempts = 0;

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async (options?: { forceRefresh?: boolean; previousAccessToken?: string }) => {
      credentialOptions.push(options);
      return options?.forceRefresh ? REFRESHED_FAKE_TOKEN : FAKE_TOKEN;
    },
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async (request, options = {}) => {
      streamRequestCalls.push({ request, signal: options.signal, knownSecrets: options.knownSecrets });
      streamAttempts += 1;
      if (streamAttempts === 1) {
        throw Object.assign(
          new Error(`Anthropic Messages API stream error: 401; authentication_error for ${FAKE_TOKEN}`),
          { status: 401, type: "authentication_error" },
        );
      }
      return "mock-sse";
    },
    parseSse: () => successfulTextEvents("msg_retried_auth"),
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.deepEqual(credentialOptions, [
    undefined,
    { forceRefresh: true, previousAccessToken: FAKE_TOKEN },
  ]);
  assert.equal(buildRequestCalls.length, 2);
  assert.equal(buildRequestCalls[0].accessToken, FAKE_TOKEN);
  assert.equal(buildRequestCalls[1].accessToken, REFRESHED_FAKE_TOKEN);
  assert.equal(streamRequestCalls.length, 2);
  assert.equal(streamRequestCalls[0].request.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(streamRequestCalls[1].request.headers.Authorization, `Bearer ${REFRESHED_FAKE_TOKEN}`);
  assert.deepEqual(streamRequestCalls[1].knownSecrets, [
    FAKE_TOKEN,
    `Bearer ${FAKE_TOKEN}`,
    REFRESHED_FAKE_TOKEN,
    `Bearer ${REFRESHED_FAKE_TOKEN}`,
  ]);
});

test("doesNotRetryOauthRefreshMoreThanOnce", async () => {
  const credentialOptions: Array<{ forceRefresh?: boolean; previousAccessToken?: string } | undefined> = [];
  const streamRequestCalls: StreamRequestCall[] = [];

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async (options?: { forceRefresh?: boolean; previousAccessToken?: string }) => {
      credentialOptions.push(options);
      return options?.forceRefresh ? REFRESHED_FAKE_TOKEN : FAKE_TOKEN;
    },
    buildRequest: requestFrom,
    streamRequest: async (request, options = {}) => {
      streamRequestCalls.push({ request, signal: options.signal, knownSecrets: options.knownSecrets });
      const token = request.headers.Authorization.replace(/^Bearer /, "");
      throw Object.assign(
        new Error(`Anthropic Messages API stream error: 401; authentication_error for ${token}`),
        { status: 401, type: "authentication_error" },
      );
    },
    parseSse: () => [],
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "error"]);
  assert.deepEqual(credentialOptions, [
    undefined,
    { forceRefresh: true, previousAccessToken: FAKE_TOKEN },
  ]);
  assert.equal(streamRequestCalls.length, 2);
  assert.equal(events[1].type, "error");
  assert.match(events[1].error.errorMessage ?? "", /authentication_error/);
  assert.match(events[1].error.errorMessage ?? "", /REDACTED/);
  assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN));
  assert.ok(!(events[1].error.errorMessage ?? "").includes(REFRESHED_FAKE_TOKEN));
});

test("abortsStreamingRequestCleanly", async () => {
  const controller = new AbortController();
  const streamRequestCalls: StreamRequestCall[] = [];

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async (request, options = {}) => {
      streamRequestCalls.push({
        request,
        signal: options.signal,
        knownSecrets: options.knownSecrets,
      });
      controller.abort();
      throw new Error(`aborted Authorization: Bearer ${FAKE_TOKEN}`);
    },
    parseSse: () => [],
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context(), { signal: controller.signal }));

  assert.equal(streamRequestCalls.length, 1);
  assert.equal(streamRequestCalls[0].signal, controller.signal);
  assert.deepEqual(eventTypes(events), ["start", "error"]);
  assert.equal(events[1].type, "error");
  assert.equal(events[1].reason, "aborted");
  assert.equal(events[1].error.stopReason, "aborted");
  assert.match(events[1].error.errorMessage ?? "", /aborted/);
  assert.match(events[1].error.errorMessage ?? "", /REDACTED/);
  assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN));
});

test("emitsAbortedErrorWhenAbortHappensDuringBodyRead", async () => {
  const controller = new AbortController();

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => {
      controller.abort();
      const abortError = new Error("The operation was aborted while reading the response body");
      abortError.name = "AbortError";
      throw abortError;
    },
    parseSse: () => [],
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context(), { signal: controller.signal }));

  assert.deepEqual(eventTypes(events), ["start", "error"]);
  assert.equal(events[1].type, "error");
  assert.equal(events[1].reason, "aborted");
  assert.equal(events[1].error.stopReason, "aborted");
  assert.match(events[1].error.errorMessage ?? "", /aborted/i);
  assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN));
});

test("redactsBareOauthTokenFromStreamErrorsViaKnownSecrets", async () => {
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => {
      throw new Error(`access_denied: ${FAKE_TOKEN} for this request`);
    },
    parseSse: () => [],
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "error"]);
  assert.equal(events[1].type, "error");
  assert.equal(events[1].reason, "error");
  assert.match(events[1].error.errorMessage ?? "", /access_denied/);
  assert.match(events[1].error.errorMessage ?? "", /REDACTED/);
  assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN));
});

test("emitsErrorWhenSseParserFailsWithoutSecretLeakage", async () => {
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => "mock-sse",
    parseSse: () => {
      throw new Error(`Anthropic SSE error Authorization: Bearer ${FAKE_TOKEN}`);
    },
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "error"]);
  assert.equal(events[1].type, "error");
  assert.equal(events[1].reason, "error");
  assert.match(events[1].error.errorMessage ?? "", /Anthropic SSE error/);
  assert.match(events[1].error.errorMessage ?? "", /REDACTED/);
  assert.ok(!(events[1].error.errorMessage ?? "").includes(FAKE_TOKEN));
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("failsClosedWhenParserReportsContractViolation", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_contract", model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "You can invoke" },
    { type: "contentBlockStop", index: 0 },
    {
      type: "contractViolation",
      code: "tool_use_stop_without_tool_use_block",
      responseId: "msg_contract",
      stopReason: "tool_use",
      message: "Anthropic stream contract violation: stop_reason=tool_use without a tool_use content block.",
    },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "error"]);
  const error = lastErrorEvent(events);
  assert.equal(error.reason, "error");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.match(error.error.errorMessage ?? "", /tool_use.*content block|contract violation/i);
});

test("failsClosedWhenParsedEventsMissMessageStop", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_truncated", model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "partial" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));

  const error = lastErrorEvent(events);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(error.reason, "error");
  assert.match(error.error.errorMessage ?? "", /message_stop/);
});

test("failsClosedWhenParsedToolCallMissesContentBlockStop", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_open_tool", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_fake", name: "bash", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: "{}" },
    { type: "messageDelta", stopReason: "tool_use" },
    { type: "messageStop", stopReason: "tool_use" },
  ]);

  const events = await collectEvents(streamSimple(model(), context()));

  const error = lastErrorEvent(events);
  assert.equal(events.some((event) => event.type === "toolcall_end"), false);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.match(error.error.errorMessage ?? "", /content block/i);
});

test("failsClosedOnParsedToolCallMissingRequiredIdOrName", async () => {
  for (const toolStart of [
    { type: "toolUseStart" as const, index: 0, id: "", name: "bash", input: {} },
    { type: "toolUseStart" as const, index: 0, id: "toolu_fake", name: "", input: {} },
  ]) {
    const { streamSimple } = createHarness([
      { type: "messageStart", responseId: "msg_bad_tool", model: "claude-sonnet-4-6" },
      toolStart,
      { type: "contentBlockStop", index: 0 },
      { type: "messageDelta", stopReason: "tool_use" },
      { type: "messageStop", stopReason: "tool_use" },
    ]);

    const events = await collectEvents(streamSimple(model(), context()));

    const error = lastErrorEvent(events);
    assert.equal(events.some((event) => event.type === "toolcall_end"), false);
    assert.equal(events.some((event) => event.type === "done"), false);
    assert.match(error.error.errorMessage ?? "", /tool_use.*id.*name/);
  }
});

test("toleratesMalformedFineGrainedToolInputJsonFromParsedEvents", async () => {
  for (const { partialJson, expectedArguments } of [
    { partialJson: "{\"command\":\"echo", expectedArguments: { command: "echo" } },
    { partialJson: "{\"command\":\"line one\nline two\"}", expectedArguments: { command: "line one\nline two" } },
  ]) {
    const { streamSimple } = createHarness([
      { type: "messageStart", responseId: "msg_bad_json", model: "claude-sonnet-4-6" },
      { type: "toolUseStart", index: 0, id: "toolu_fake", name: "bash", input: {} },
      { type: "toolUseInputDelta", index: 0, partialJson },
      { type: "contentBlockStop", index: 0 },
      { type: "messageDelta", stopReason: "tool_use" },
      { type: "messageStop", stopReason: "tool_use" },
    ]);

    const events = await collectEvents(streamSimple(model(), context()));
    const toolcallEnd = events.find((event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end");
    const done = events.at(-1);

    assert.deepEqual(eventTypes(events), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    assert.ok(toolcallEnd, "stream should emit a toolcall_end event");
    assert.deepEqual(toolcallEnd.toolCall.arguments, expectedArguments);
    assert.ok(done && done.type === "done", "stream should finish successfully");
    assert.equal(done.reason, "toolUse");
  }
});

test("failsClosedWhenFinalToolInputJsonIsNonObjectOrUnparseable", async () => {
  for (const { partialJson, expectedMessage } of [
    { partialJson: "[]", expectedMessage: /must parse to an object/ },
    { partialJson: '{"path":"/tmp/x","', expectedMessage: /Unable to parse Anthropic tool input JSON/ },
  ]) {
    const { streamSimple } = createHarness([
      { type: "messageStart", responseId: "msg_bad_final_json", model: "claude-sonnet-4-6" },
      { type: "toolUseStart", index: 0, id: "toolu_fake", name: "edit", input: {} },
      { type: "toolUseInputDelta", index: 0, partialJson },
      { type: "contentBlockStop", index: 0 },
      { type: "messageDelta", stopReason: "tool_use" },
      { type: "messageStop", stopReason: "tool_use" },
    ]);

    const events = await collectEvents(streamSimple(model(), context()));
    const error = lastErrorEvent(events);

    assert.equal(events.some((event) => event.type === "toolcall_end"), false);
    assert.equal(events.some((event) => event.type === "done"), false);
    assert.match(error.error.errorMessage ?? "", expectedMessage);
    assert.equal(
      error.error.content.some((block) => block.type === "toolCall"),
      false,
      "errored assistant message must not retain a malformed tool call",
    );
  }
});

test("callsOnPayloadHookAndUsesReplacementPayload", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_payload", model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const hookPayloads: unknown[] = [];
  const events = await collectEvents(streamSimple(model(), context(), {
    onPayload: async (payload) => {
      hookPayloads.push(payload);
      return { ...(payload as Record<string, unknown>), max_tokens: 123, metadata: { hook: true } };
    },
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(hookPayloads.length, 1);
  assert.equal(buildRequestCalls.length, 1);
  assert.equal(buildRequestCalls[0].payload.max_tokens, 123);
  assert.deepEqual(buildRequestCalls[0].payload.metadata, { hook: true });
});

test("passesOnResponseHookToNativeStreamRequest", async () => {
  let hookResponse: unknown;
  let hookModel: Model<Api> | undefined;

  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async (_request, options = {}) => {
      await options.onResponse?.({ status: 202, headers: { "x-hook": "seen" } });
      return "mock-sse";
    },
    parseSse: () => [
      { type: "messageStart", responseId: "msg_response", model: "claude-sonnet-4-6" },
      { type: "textStart", index: 0, text: "" },
      { type: "textDelta", index: 0, text: "ok" },
      { type: "contentBlockStop", index: 0 },
      { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
      { type: "messageStop", stopReason: "end_turn" },
    ],
    now: () => 1234567890,
  });

  const selectedModel = model();
  const events = await collectEvents(streamSimple(selectedModel, context(), {
    onResponse: async (response, responseModel) => {
      hookResponse = response;
      hookModel = responseModel;
    },
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(hookResponse, { status: 202, headers: { "x-hook": "seen" } });
  assert.equal(hookModel, selectedModel);
});

test("streamNativeMessagesSseCallsOnResponseBeforeReturningBody", async () => {
  const originalFetch = globalThis.fetch;
  let hookResponse: unknown;

  try {
    globalThis.fetch = (async () => new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", {
      status: 200,
      headers: { "request-id": "req_hook" },
    })) as typeof fetch;

    const body = await streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
      onResponse: async (response) => { hookResponse = response; },
    });

    assert.match(body, /message_stop/);
    assert.deepEqual(hookResponse, { status: 200, headers: { "content-type": "text/plain;charset=UTF-8", "request-id": "req_hook" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamNativeMessagesSsePassesTheKeepAliveDispatcherToFetch", async () => {
  resetNativeFetchDispatcherForTests();
  const originalFetch = globalThis.fetch;
  const originalKeepAliveEnv = process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  delete process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  const dispatchers: unknown[] = [];

  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher);
      return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200 });
    }) as typeof fetch;

    await streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }));
    await streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }));

    assert.equal(dispatchers.length, 2);
    assert.ok(dispatchers[0] !== undefined, "fetch must receive the keep-alive dispatcher");
    assert.equal(dispatchers[0], dispatchers[1], "both requests must reuse the same dispatcher instance (shared connection pool)");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKeepAliveEnv !== undefined) process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS = originalKeepAliveEnv;
    resetNativeFetchDispatcherForTests();
  }
});

test("streamNativeMessagesSseRetriesOnceWithoutDispatcherWhenFetchRejectsItsHandlerProtocol", async () => {
  // A fetch implementation from a different undici copy rejects a foreign
  // dispatcher synchronously inside dispatch (UND_ERR_INVALID_ARG), before any
  // bytes reach the network. The transport must retry once without the
  // dispatcher and keep it disabled for the rest of the process instead of
  // failing every request.
  resetNativeFetchDispatcherForTests();
  const originalFetch = globalThis.fetch;
  const originalKeepAliveEnv = process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  delete process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  const dispatchers: unknown[] = [];

  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher);
      if (init?.dispatcher !== undefined) {
        throw new TypeError("fetch failed", { cause: { code: "UND_ERR_INVALID_ARG", message: "invalid onRequestStart method" } });
      }
      return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200 });
    }) as typeof fetch;

    const body = await streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }));
    assert.match(body, /message_stop/);
    assert.equal(dispatchers.length, 2, "first request must retry once without the dispatcher");
    assert.ok(dispatchers[0] !== undefined);
    assert.equal(dispatchers[1], undefined);

    await streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }));
    assert.equal(dispatchers.length, 3, "later requests must not retry");
    assert.equal(dispatchers[2], undefined, "the dispatcher must stay disabled for the process");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKeepAliveEnv !== undefined) process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS = originalKeepAliveEnv;
    resetNativeFetchDispatcherForTests();
  }
});

test("streamNativeMessagesSseSurfacesNonDispatcherTransportErrorsWithoutRetry", async () => {
  resetNativeFetchDispatcherForTests();
  const originalFetch = globalThis.fetch;
  const originalKeepAliveEnv = process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  delete process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  let fetchCalls = 0;

  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } });
    }) as typeof fetch;

    await assert.rejects(
      () => streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } })),
      /Anthropic Messages API stream transport error/,
    );
    assert.equal(fetchCalls, 1, "non-compatibility transport errors must not trigger a dispatcherless retry");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKeepAliveEnv !== undefined) process.env.PI_CLAUDE_HTTP_KEEPALIVE_MS = originalKeepAliveEnv;
    resetNativeFetchDispatcherForTests();
  }
});

test("streamNativeMessagesSseRejectsNonAnthropicUrlBeforeFetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("should not be reached", { status: 200 });
    }) as typeof fetch;

    const exfiltrationRequest: NativeMessagesRequest = {
      ...requestFrom({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
      url: "https://attacker.example/exfiltrate",
    };

    await assert.rejects(
      () => streamNativeMessagesSse(exfiltrationRequest, {
        knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`],
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.ok(err.message.includes("Anthropic Messages API stream refused outbound URL"), "error must mention the outbound URL rejection");
        assert.ok(!err.message.includes("attacker.example"), "error must not echo attacker-controlled URL");
        assert.ok(!err.message.includes(FAKE_TOKEN), "error must not leak OAuth token");
        return true;
      },
    );

    assert.equal(fetchCalls, 0, "globalThis.fetch must not be invoked when the URL invariant fails");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamNativeMessagesSseReportsAnthropicRequestIdOnError", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => new Response(
      `internal server error Authorization: Bearer ${FAKE_TOKEN}`,
      {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "anthropic-request-id": "req_anthropic_500" },
      },
    )) as typeof fetch;

    await assert.rejects(
      () => streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
        knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`],
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /500/);
        assert.match(err.message, /req_anthropic_500/);
        assert.match(err.message, /REDACTED/);
        assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
        assert.ok(!err.message.includes(`Bearer ${FAKE_TOKEN}`), "must not leak bearer token");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfacesDetailedRequestAndResponseDiagnosticsForPreStreamOverageErrors", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
        },
        request_id: "req_overage_tools",
      }),
      {
        status: 400,
        headers: {
          "request-id": "req_overage_tools",
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": "0.08",
          "anthropic-ratelimit-unified-7d-utilization": "0.03",
          "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled_until",
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "retry-after": "12",
        },
      },
    )) as typeof fetch;

    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => FAKE_TOKEN,
      buildRequest: (input) => buildNativeMessagesRequest(input),
      now: () => 1234567890,
    });

    const events = await collectEvents(streamSimple(model("claude-opus-4-8", {
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: { forceAdaptiveThinking: true } as never,
      thinkingLevelMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
    }), {
      systemPrompt: "Pi system prompt SHOULD_NOT_LEAK_SYSTEM_PROMPT",
      messages: [{ role: "user", content: "hello SHOULD_NOT_LEAK_USER_TEXT", timestamp: 0 }],
      tools: [
        {
          name: "read",
          description: "READ_DESCRIPTION_SHOULD_NOT_LEAK",
          parameters: {
            type: "object",
            properties: { secretPathKey: { type: "string" } },
            required: ["secretPathKey"],
          },
        },
        {
          name: "mcp_secret_tool",
          description: "MCP_DESCRIPTION_SHOULD_NOT_LEAK",
          parameters: {
            type: "object",
            properties: { tokenValue: { type: "string" } },
            required: ["tokenValue"],
          },
        },
      ],
    }, { reasoning: "medium" }));

    const error = lastErrorEvent(events);
    const message = error.error.errorMessage ?? "";

    assert.match(message, /You're out of extra usage/);
    assert.match(message, /status=400/);
    assert.match(message, /request_id=req_overage_tools/);
    assert.match(message, /anthropic_error_type=invalid_request_error/);
    assert.match(message, /response_content-type=application\/json/);
    assert.match(message, /response_anthropic-ratelimit-unified-5h-utilization=0.08/);
    assert.match(message, /response_anthropic-ratelimit-unified-7d-utilization=0.03/);
    assert.match(message, /response_anthropic-ratelimit-unified-overage-disabled-reason=org_level_disabled_until/);
    assert.match(message, /response_anthropic-ratelimit-unified-status=allowed_warning/);
    assert.match(message, /response_retry-after=12/);
    assert.match(message, /model=claude-opus-4-8/);
    assert.match(message, /model_provider=claude-subscription/);
    assert.match(message, /model_api=claude-subscription-native/);
    assert.match(message, /model_context_window=1000000/);
    assert.match(message, /model_max_tokens=128000/);
    assert.match(message, /model_reasoning=true/);
    assert.match(message, /requested_reasoning=medium/);
    assert.match(message, /method=POST/);
    assert.match(message, /endpoint=\/v1\/messages/);
    assert.match(message, /auth=oauth_bearer/);
    assert.match(message, /anthropic_version=2023-06-01/);
    assert.match(message, /request_content_type=application\/json/);
    assert.match(message, /body_bytes=\d+/);
    assert.match(message, /body_shape_hash=[a-f0-9]{16}/);
    assert.match(message, /body_keys=.*messages.*tools/);
    assert.match(message, /body_config_keys=max_tokens\|output_config\|stream\|thinking/);
    assert.match(message, /max_tokens=128000/);
    assert.match(message, /stream=true/);
    assert.match(message, /thinking=adaptive/);
    assert.match(message, /thinking_display=summarized/);
    assert.match(message, /effort=high/);
    assert.match(message, /output_config_keys=effort/);
    assert.match(message, /tools=2/);
    assert.match(message, /tool_names=read\|mcp_secret_tool/);
    assert.match(message, /tool_json_bytes_total=\d+/);
    assert.match(message, /tool_schema_bytes_total=\d+/);
    assert.match(message, /tool_description_bytes_total=\d+/);
    assert.match(message, /tool_shape_hash=[a-f0-9]{16}/);
    assert.match(message, /tool_prefix_counts=mcp_=1/);
    assert.match(message, /tool_stats=read:bytes=\d+:schema=\d+:desc=\d+:props=1:required=1:cache=0:schema_hash=[a-f0-9]{16}:desc_hash=[a-f0-9]{16}\|mcp_secret_tool:bytes=\d+:schema=\d+:desc=\d+:props=1:required=1:cache=1:schema_hash=[a-f0-9]{16}:desc_hash=[a-f0-9]{16}/);
    assert.match(message, /system_blocks=2/);
    assert.match(message, /system_text_blocks=2/);
    assert.match(message, /system_text_bytes=\d+/);
    assert.match(message, /messages=1/);
    assert.match(message, /message_bytes=\d+/);
    assert.match(message, /message_roles=user=1/);
    assert.match(message, /message_blocks=text=1/);
    assert.match(message, /message_text_bytes=\d+/);
    assert.match(message, /message_image_blocks=0/);
    assert.match(message, /message_tool_use_blocks=0/);
    assert.match(message, /message_tool_result_blocks=0/);
    assert.match(message, /message_thinking_blocks=0/);
    assert.match(message, /cache_controls=4/);
    assert.match(message, /anthropic_beta=oauth-2025-04-20\|claude-code-20250219/);
    assert.match(message, /request_markers=x_app=0,ua_claude_cli=0,cc_session=0,client_request_id=0,billing_header=0,metadata_user_id=0/);
    assert.ok(!message.includes("SHOULD_NOT_LEAK"), "diagnostics must not include raw prompt/tool-description text");
    assert.ok(!message.includes("secretPathKey"), "diagnostics must not include raw schema property names");
    assert.ok(!message.includes("tokenValue"), "diagnostics must not include raw schema property names");
    assert.ok(!message.includes(FAKE_TOKEN), "diagnostics must not leak OAuth token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamNativeMessagesSseReportsFetchFailureCauseWithoutLeakingSecrets", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error(`socket closed Authorization: Bearer ${FAKE_TOKEN}`),
          { code: "UND_ERR_SOCKET" },
        ),
      });
    }) as typeof fetch;

    await assert.rejects(
      () => streamNativeMessagesSse(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
        knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`],
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /fetch failed/);
        assert.match(err.message, /UND_ERR_SOCKET/);
        assert.match(err.message, /REDACTED/);
        assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
        assert.ok(!err.message.includes(`Bearer ${FAKE_TOKEN}`), "must not leak bearer token");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createNativeStreamSimpleConsumesAsyncIterableEvents", async () => {
  const buildRequestCalls: BuildRequestCall[] = [];
  let streamRequestCalls = 0;
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async () => {
      streamRequestCalls++;
      return (async function* () {
        yield* successfulTextEvents("msg_async_iterable");
      })();
    },
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));

  assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.equal(streamRequestCalls, 1);
  assert.equal(buildRequestCalls.length, 1);
  assert.equal(events.at(-1)?.type, "done");
});

test("defaultStreamPathParsesChunkSplitToolSseAndRecordsMetadataOnlyDiagnostics", async () => {
  resetNativeToolCallDiagnostics();
  const originalFetch = globalThis.fetch;
  const partialJson = '{"command":"echo fake-secret && cat /tmp/private-file"}';
  const toolDeltaFrame = sseFrame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });

  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sseFrame("message_start", {
          type: "message_start",
          message: { id: "msg_default_tool", model: "claude-sonnet-4-6", content: [] },
        })));
        controller.enqueue(encoder.encode(sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_default", name: "bash", input: {} },
        })));
        controller.enqueue(encoder.encode(toolDeltaFrame.slice(0, 80)));
        controller.enqueue(encoder.encode(toolDeltaFrame.slice(80)));
        controller.enqueue(encoder.encode(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 })));
        controller.enqueue(encoder.encode(sseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 1 },
        })));
        controller.enqueue(encoder.encode(sseFrame("message_stop", { type: "message_stop" })));
        controller.close();
      },
    }), { status: 200, headers: { "request-id": "req_default_tool" } })) as typeof fetch;

    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => FAKE_TOKEN,
      now: () => 1234567890,
    });
    const events = await collectEvents(streamSimple(model(), context(), { sessionId: "session-default-tool" }));
    const done = events.at(-1);
    const snapshot = getNativeToolCallDiagnosticsSnapshot();

    assert.ok(done && done.type === "done");
    assert.deepEqual(done.message.content, [{
      type: "toolCall",
      id: "toolu_default",
      name: "bash",
      arguments: { command: "echo fake-secret && cat /tmp/private-file" },
    }]);
    assert.deepEqual(snapshot.samples, [{
      timestamp: 1234567890,
      model: "claude-sonnet-4-6",
      responseId: "msg_default_tool",
      sessionId: "session-default-tool",
      toolName: "bash",
      argByteLength: Buffer.byteLength(partialJson, "utf8"),
      deltaChunkCount: 1,
      topLevelKeyCount: 1,
      finalOutcome: "clean",
    }]);
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes("fake-secret"));
    assert.ok(!serialized.includes("/tmp/private-file"));
    assert.ok(!serialized.includes("command"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamNativeMessagesSseEventsParsesResponseBodyIncrementally", async () => {
  const originalFetch = globalThis.fetch;
  const observedTypes: string[] = [];
  let hookCalled = false;

  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stream\",\"model\":\"claude-sonnet-4-6\"}}\n\n"));
        controller.enqueue(encoder.encode("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"));
        controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"));
        controller.enqueue(encoder.encode("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"));
        controller.enqueue(encoder.encode("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n"));
        controller.enqueue(encoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "request-id": "req_stream" } })) as typeof fetch;

    for await (const event of await streamNativeMessagesSseEvents(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
      onResponse: async (response) => {
        hookCalled = true;
        assert.equal(response.status, 200);
      },
    })) {
      observedTypes.push(event.type);
    }

    assert.equal(hookCalled, true);
    assert.deepEqual(observedTypes, ["messageStart", "textStart", "textDelta", "contentBlockStop", "messageDelta", "messageStop"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamNativeMessagesSseEventsCleansUpAbortListenerWhenOnResponseFails", async () => {
  const originalFetch = globalThis.fetch;
  const abortController = new AbortController();
  const originalRemoveEventListener = abortController.signal.removeEventListener.bind(abortController.signal);
  let removeAbortListenerCalls = 0;

  abortController.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    if (args[0] === "abort") removeAbortListenerCalls += 1;
    return originalRemoveEventListener(...args);
  }) as AbortSignal["removeEventListener"];

  try {
    globalThis.fetch = (async () => new Response(new ReadableStream(), { status: 200 })) as typeof fetch;

    await assert.rejects(
      () => streamNativeMessagesSseEvents(requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
        signal: abortController.signal,
        timeoutMs: 1000,
        onResponse: async () => { throw new Error("hook failed"); },
      }),
      /hook failed/,
    );

    assert.equal(removeAbortListenerCalls, 1, "abort listener must be removed when onResponse rejects");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capturesInputAndCacheUsageFromMessageStartEvent", async () => {
  const { streamSimple } = createHarness([
    {
      type: "messageStart",
      responseId: "msg_usage_start",
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "done" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 7 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), context()));
  const done = events.at(-1);

  assert.ok(done && done.type === "done", "stream should finish successfully");
  assert.deepEqual(done.message.usage, {
    input: 100,
    output: 7,
    cacheRead: 80,
    cacheWrite: 20,
    totalTokens: 207,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("preservesInputAndCacheUsageWhenLaterStreamDeltasContainZeroCounts", async () => {
  const { streamSimple } = createHarness([
    {
      type: "messageStart",
      responseId: "msg_usage_zero_delta",
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "done" },
    { type: "contentBlockStop", index: 0 },
    {
      type: "messageDelta",
      stopReason: "end_turn",
      usage: {
        input_tokens: 0,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), context()));
  const done = events.at(-1);

  assert.ok(done && done.type === "done", "stream should finish successfully");
  assert.deepEqual(done.message.usage, {
    input: 100,
    output: 7,
    cacheRead: 80,
    cacheWrite: 20,
    totalTokens: 207,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("recordsLocalUsageTelemetryAfterSuccessfulNativeStreams", async () => {
  await drainDeferredTelemetry();
  resetNativeUsageTelemetry();
  const { streamSimple } = createHarness([
    {
      type: "messageStart",
      responseId: "msg_telemetry_stream",
      model: "claude-opus-4-7-20260101",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "done" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 7 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(model("claude-opus-4-7"), context(), { sessionId: "session-telemetry" }));
  await drainDeferredTelemetry();

  const snapshot = getNativeUsageTelemetrySnapshot();
  assert.equal(snapshot.records.length, 1);
  assert.deepEqual(snapshot.records[0], {
    timestamp: 1234567890,
    model: "claude-opus-4-7",
    responseModel: "claude-opus-4-7-20260101",
    responseId: "msg_telemetry_stream",
    sessionId: "session-telemetry",
    usage: {
      input: 100,
      output: 7,
      cacheRead: 80,
      cacheWrite: 20,
      totalTokens: 207,
    },
    requestFingerprint: snapshot.records[0].requestFingerprint,
  });
  assert.match(snapshot.records[0].requestFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(snapshot.totals.cacheHitRatio, 0.4);
});

test("recordsCacheBreakDiagnosticsAfterSuccessfulNativeStreams", async () => {
  await drainDeferredTelemetry();
  resetNativeCacheDiagnostics();
  const usageEvents = [
    {
      input_tokens: 20,
      output_tokens: 2,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 10,
    },
    {
      input_tokens: 210,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 180,
    },
  ];
  let call = 0;
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => buildNativeMessagesRequest(input),
    streamRequest: async () => "mock-sse",
    parseSse: () => {
      const usage = usageEvents[call] ?? usageEvents.at(-1)!;
      call++;
      return [
        { type: "messageStart", responseId: `msg_cache_diag_${call}`, model: "claude-sonnet-4-6", usage },
        { type: "textStart", index: 0, text: "" },
        { type: "textDelta", index: 0, text: "ok" },
        { type: "contentBlockStop", index: 0 },
        { type: "messageStop", stopReason: "end_turn" },
      ];
    },
    now: () => 1234567890 + call,
  });

  await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
  }, { sessionId: "session-cache-break" }));
  await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [{ name: "bash", description: "Run commands", parameters: { type: "object" } }],
  }, { sessionId: "session-cache-break" }));
  await drainDeferredTelemetry();

  const snapshot = getNativeCacheDiagnosticsSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].kind, "cache-read-drop");
  assert.deepEqual(snapshot.events[0].changedSections, ["tools"]);
  assert.equal(snapshot.events[0].previousCacheRead, 200);
  assert.equal(snapshot.events[0].currentCacheRead, 5);
});

test("streamsRedactedThinkingBlocksForReplay", async () => {
  const { streamSimple } = createHarness([
    { type: "messageStart", responseId: "msg_redacted", model: "claude-opus-4-7" },
    { type: "redactedThinkingStart", index: 0, data: "encrypted-thinking-payload" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), context()));
  const done = events.at(-1);

  assert.deepEqual(eventTypes(events), ["start", "thinking_start", "thinking_end", "done"]);
  assert.ok(done && done.type === "done");
  assert.deepEqual(done.message.content, [{
    type: "thinking",
    thinking: "",
    thinkingSignature: "encrypted-thinking-payload",
    redacted: true,
  }]);
});

test("replaysMixedSignedThinkingTextAndToolCallBlocks", async () => {
  const { streamSimple, buildRequestCalls } = createHarness(successfulTextEvents("msg_mixed_replay"));
  const mixedAssistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should call bash.", thinkingSignature: "sig-abc", redacted: false },
      { type: "text", text: "Let me run that." },
      { type: "toolCall", id: "toolu_xyz", name: "bash", arguments: { command: "ls" } },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-opus-4-7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "toolu_xyz",
    toolName: "bash",
    content: [{ type: "text", text: "file.txt" }],
    isError: false,
    timestamp: 1,
  };

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), {
    messages: [mixedAssistantMessage, toolResult],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should call bash.", signature: "sig-abc" },
        { type: "text", text: "Let me run that." },
        { type: "tool_use", id: "toolu_xyz", name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_xyz", content: "file.txt", is_error: false }],
    },
  ]);
});

test("skipsUnsignedThinkingBlocksWhenBuildingReplayPayload", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_replay", model: "claude-opus-4-7" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(model("claude-opus-4-7"), {
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "partial unsigned reasoning", thinkingSignature: "" },
        { type: "text", text: "signed answer" },
      ],
      api: SUBSCRIPTION_NATIVE_API_ID,
      provider: PROVIDER_ID,
      model: "claude-opus-4-7",
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
    }],
  }));

  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [{ type: "text", text: "signed answer" }],
  }]);
});

test("replaysRedactedThinkingBlocksWithAnthropicRedactedThinkingType", async () => {
  const { streamSimple, buildRequestCalls } = createHarness([
    { type: "messageStart", responseId: "msg_redacted_replay", model: "claude-opus-4-7" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);

  await collectEvents(streamSimple(model("claude-opus-4-7"), {
    messages: [{
      role: "assistant",
      content: [{
        type: "thinking",
        thinking: "",
        thinkingSignature: "encrypted-thinking-payload",
        redacted: true,
      }],
      api: SUBSCRIPTION_NATIVE_API_ID,
      provider: PROVIDER_ID,
      model: "claude-opus-4-7",
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
    }],
  }));

  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [{ type: "redacted_thinking", data: "encrypted-thinking-payload" }],
  }]);
});

test("dropsToolCallBlocksFromErroredAssistantMessageWhenStreamFailsBeforeMessageStop", async () => {
  // Regression: if Anthropic streams a tool_use mid-flight and the connection
  // then drops (e.g. UND_ERR_SOCKET) before message_stop, Pi must not surface
  // an errored assistant message that still contains an executable-looking
  // tool call. The error is preserved; only toolCall blocks are stripped.
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => (async function* () {
      yield { type: "messageStart", responseId: "msg_interrupted", model: "claude-sonnet-4-6" } as AnthropicSseEvent;
      yield { type: "toolUseStart", index: 0, id: "toolu_edit", name: "edit", input: {} } as AnthropicSseEvent;
      yield { type: "toolUseInputDelta", index: 0, partialJson: '{"path":"/tmp/x","' } as AnthropicSseEvent;
      yield { type: "toolUseInputDelta", index: 0, partialJson: 'old":"a","new":"b"}' } as AnthropicSseEvent;
      yield { type: "contentBlockStop", index: 0 } as AnthropicSseEvent;
      throw Object.assign(new TypeError("terminated"), {
        cause: Object.assign(
          new Error("other side closed"),
          { code: "UND_ERR_SOCKET" },
        ),
      });
    })(),
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const error = lastErrorEvent(events);

  assert.equal(error.reason, "error");
  assert.equal(error.error.stopReason, "error");
  assert.match(error.error.errorMessage ?? "", /terminated/);
  assert.match(error.error.errorMessage ?? "", /UND_ERR_SOCKET/);
  assert.match(error.error.errorMessage ?? "", /other side closed/);
  // Diagnostics block surfaces safe metadata only.
  assert.match(error.error.errorMessage ?? "", /saw_message_stop=false/);
  assert.match(error.error.errorMessage ?? "", /saw_tool_block=true/);
  assert.match(error.error.errorMessage ?? "", /last_event=contentBlockStop/);
  assert.ok(!(error.error.errorMessage ?? "").includes(FAKE_TOKEN));
  assert.ok(!(error.error.errorMessage ?? "").includes(`Bearer ${FAKE_TOKEN}`));
  // No toolCall block remains on the errored assistant message.
  assert.equal(
    error.error.content.some((block) => block.type === "toolCall"),
    false,
    "errored assistant message must not retain tool-call blocks",
  );
});

test("surfacesSafeRequestAndToolProgressDiagnosticsWhenBodyStallsMidToolInput", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const rawSecretPath = "/tmp/fake-secret-project/file.txt";
        controller.enqueue(encoder.encode(sseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_stall_diagnostics",
            model: "claude-opus-4-8",
            usage: { input_tokens: 2, cache_read_input_tokens: 203043, cache_creation_input_tokens: 2391 },
          },
        })));
        controller.enqueue(encoder.encode(sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_edit_stall", name: "edit", input: {} },
        })));
        controller.enqueue(encoder.encode(sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: `{"path":"${rawSecretPath}","oldText":"` },
        })));
        controller.enqueue(encoder.encode(sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "old content\",\"newText\":\"new content\"}" },
        })));
        // Never close: the test relies on the no-progress timeout to abort mid tool input.
      },
    }), { status: 200, headers: { "request-id": "req_stall_diagnostics" } })) as typeof fetch;

    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => FAKE_TOKEN,
      buildRequest: (input) => buildNativeMessagesRequest(input),
      now: () => 1234567890,
    });
    const streamOptions = { reasoning: "medium" as const, streamNoProgressTimeoutMs: 25 };

    const events = await collectEvents(streamSimple(model("claude-opus-4-8", {
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: { forceAdaptiveThinking: true } as never,
      thinkingLevelMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
    }), {
      systemPrompt: "Pi system prompt",
      messages: [{ role: "user", content: "make the edit", timestamp: 0 }],
      tools: [{ name: "edit", description: "Edit files", parameters: { type: "object" } }],
    }, streamOptions));

    const error = lastErrorEvent(events);
    const message = error.error.errorMessage ?? "";

    assert.match(message, /made no progress for 25ms/);
    assert.match(message, /status=200/);
    assert.match(message, /request_id=req_stall_diagnostics/);
    assert.match(message, /last_event=toolUseInputDelta/);
    assert.match(message, /model=claude-opus-4-8/);
    assert.match(message, /response_model=claude-opus-4-8/);
    assert.match(message, /response_id=msg_stall_diagnostics/);
    assert.match(message, /max_tokens=128000/);
    assert.match(message, /thinking=adaptive/);
    assert.match(message, /effort=high/);
    assert.match(message, /tools=1/);
    assert.ok(!message.includes("disable_parallel_tool_use"), "tool_choice is omitted, so the serial flag is no longer in diagnostics");
    assert.match(message, /open_content_blocks=1/);
    assert.match(message, /open_tool=edit/);
    assert.match(message, /tool_json_deltas=2/);
    assert.match(message, /tool_json_bytes=\d+/);
    assert.match(message, /usage_cache_read=203043/);
    assert.match(message, /usage_cache_write=2391/);
    assert.ok(!message.includes("fake-secret-project"), "must not include raw tool argument values");
    assert.ok(!message.includes("oldText"), "must not include raw tool argument key names");
    assert.ok(!message.includes("newText"), "must not include raw tool argument key names");
    assert.equal(
      error.error.content.some((block) => block.type === "toolCall"),
      false,
      "partial toolCall block must still be dropped",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfacesNoProgressTimeoutWhenAnthropicResponseBodyStalls", async () => {
  // If the Anthropic SSE body stops emitting chunks after a successful tool
  // use, Pi must eventually surface a clear progress error instead of leaving
  // the user stuck on "Working...".
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stall\",\"model\":\"claude-sonnet-4-6\"}}\n\n"));
        // Never close: the test relies on the no-progress timeout to abort.
      },
    }), { status: 200, headers: { "request-id": "req_stall" } })) as typeof fetch;

    await assert.rejects(
      (async () => {
        for await (const _event of await streamNativeMessagesSseEvents(
          requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
          { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`], streamNoProgressTimeoutMs: 25 },
        )) {
          // Drain events until the stalled reader rejects with a progress error.
        }
      })(),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /made no progress for 25ms/);
        assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("doesNotAbortActiveLargeToolInputStreamAtProviderTimeout", async () => {
  // Reproduces the observed session failure: Opus 4.8 was allowed the full
  // 128k output cap, then spent longer than Pi's 300s provider timeout actively
  // streaming a large write/edit tool JSON argument. An active SSE body must be
  // governed by the no-progress watchdog, not by an absolute post-response timer.
  const originalFetch = globalThis.fetch;
  let capturedPayload: Record<string, unknown> | undefined;

  try {
    globalThis.fetch = (async (_input, init) => {
      capturedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const signal = init?.signal;
      const encoder = new TextEncoder();
      const timers: Array<ReturnType<typeof setTimeout>> = [];

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enqueueLater = (delayMs: number, frame: string) => {
            timers.push(setTimeout(() => {
              if (signal?.aborted) return;
              controller.enqueue(encoder.encode(frame));
            }, delayMs));
          };
          const closeLater = (delayMs: number) => {
            timers.push(setTimeout(() => {
              if (signal?.aborted) return;
              controller.close();
            }, delayMs));
          };

          signal?.addEventListener("abort", () => {
            for (const timer of timers) clearTimeout(timer);
            controller.error(signal.reason ?? new Error("aborted"));
          }, { once: true });

          enqueueLater(0, sseFrame("message_start", {
            type: "message_start",
            message: { id: "msg_large_tool_input", model: "claude-opus-4-8", content: [] },
          }));
          enqueueLater(5, sseFrame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_write_large_plan", name: "write", input: {} },
          }));
          enqueueLater(10, sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/plan.md","content":"' },
          }));
          enqueueLater(20, sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "large-plan-chunk-" },
          }));
          enqueueLater(40, sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "still-progressing" },
          }));
          enqueueLater(50, sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"}' },
          }));
          enqueueLater(60, sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
          enqueueLater(65, sseFrame("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 123 },
          }));
          enqueueLater(70, sseFrame("message_stop", { type: "message_stop" }));
          closeLater(75);
        },
        cancel() {
          for (const timer of timers) clearTimeout(timer);
        },
      });

      return new Response(body, { status: 200, headers: { "request-id": "req_large_tool_input" } });
    }) as typeof fetch;

    const streamSimple = createNativeStreamSimple({
      loadCredentials: async () => FAKE_TOKEN,
      buildRequest: (input) => buildNativeMessagesRequest(input),
      now: () => 1234567890,
    });
    const events = await collectEvents(streamSimple(model("claude-opus-4-8", {
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: { forceAdaptiveThinking: true } as never,
    }), {
      systemPrompt: "Pi system prompt",
      messages: [{ role: "user", content: "write a very large plan", timestamp: 0 }],
      tools: [{ name: "write", description: "Write files", parameters: { type: "object" } }],
    }, {
      timeoutMs: 25,
    }));

    assert.equal(capturedPayload?.max_tokens, 128000, "Opus 4.8 default max_tokens is large enough to permit long tool-input streams");
    const finalEvent = events.at(-1);
    assert.equal(
      finalEvent?.type,
      "done",
      finalEvent?.type === "error" ? finalEvent.error.errorMessage : undefined,
    );
    assert.deepEqual(eventTypes(events), ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bodyNoProgressWatchdogDoesNotAllocateTimerPerChunk", async () => {
  // Active streams can emit thousands of SSE chunks (especially large tool JSON).
  // The no-progress watchdog should not allocate/clear one timer per chunk; it
  // only needs one body watchdog after response headers arrive.
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const noProgressTimeoutMs = 10_000;
  const bodyChunkCount = 64;
  let scheduledMatchingTimers = 0;

  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === noProgressTimeoutMs) scheduledMatchingTimers += 1;
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer) => originalClearTimeout(timer)) as typeof clearTimeout;

    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const enqueue = (frame: string) => controller.enqueue(encoder.encode(frame));
        enqueue(sseFrame("message_start", {
          type: "message_start",
          message: { id: "msg_timer_churn", model: "claude-sonnet-4-6", content: [] },
        }));
        enqueue(sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }));
        for (let index = 0; index < bodyChunkCount; index += 1) {
          enqueue(sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "x" },
          }));
        }
        enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
        enqueue(sseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }));
        enqueue(sseFrame("message_stop", { type: "message_stop" }));
        controller.close();
      },
    }), { status: 200, headers: { "request-id": "req_timer_churn" } })) as typeof fetch;

    let eventCount = 0;
    for await (const _event of await streamNativeMessagesSseEvents(
      requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
      { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`], streamNoProgressTimeoutMs: noProgressTimeoutMs },
    )) {
      eventCount += 1;
    }

    assert.equal(eventCount, bodyChunkCount + 5, "sanity check: all streamed events were consumed");
    assert.ok(
      scheduledMatchingTimers <= 2,
      `body watchdog must not allocate per chunk; scheduled ${scheduledMatchingTimers} matching timers for ${bodyChunkCount} chunks`,
    );
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("bodyNoProgressWatchdogIgnoresDownstreamBackpressure", async () => {
  // The body watchdog measures Anthropic/network read idleness. It must not fire
  // while the caller is paused after receiving an already-read event.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const enqueue = (frame: string) => controller.enqueue(encoder.encode(frame));
        enqueue(sseFrame("message_start", {
          type: "message_start",
          message: { id: "msg_slow_consumer", model: "claude-sonnet-4-6", content: [] },
        }));
        enqueue(sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }));
        enqueue(sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }));
        enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
        enqueue(sseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }));
        enqueue(sseFrame("message_stop", { type: "message_stop" }));
        controller.close();
      },
    }), { status: 200, headers: { "request-id": "req_slow_consumer" } })) as typeof fetch;

    let eventCount = 0;
    for await (const _event of await streamNativeMessagesSseEvents(
      requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
      { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`], streamNoProgressTimeoutMs: 25 },
    )) {
      eventCount += 1;
      if (eventCount === 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(eventCount, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bodyNoProgressWatchdogCleansUpOnEarlyConsumerBreak", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const noProgressTimeoutMs = 10_000;
  const watchdogTimers = new Set<unknown>();
  let scheduledWatchdogTimers = 0;
  let clearedWatchdogTimers = 0;
  let bodyCanceled = false;

  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === noProgressTimeoutMs) {
        scheduledWatchdogTimers += 1;
        watchdogTimers.add(timer);
      }
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer) => {
      if (watchdogTimers.delete(timer)) clearedWatchdogTimers += 1;
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;

    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sseFrame("message_start", {
          type: "message_start",
          message: { id: "msg_early_break", model: "claude-sonnet-4-6", content: [] },
        })));
      },
      cancel() {
        bodyCanceled = true;
      },
    }), { status: 200, headers: { "request-id": "req_early_break" } })) as typeof fetch;

    for await (const _event of await streamNativeMessagesSseEvents(
      requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
      { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`], streamNoProgressTimeoutMs: noProgressTimeoutMs },
    )) {
      break;
    }

    assert.equal(bodyCanceled, true, "breaking early cancels the response body reader");
    assert.equal(scheduledWatchdogTimers, 2, "response-start and first pending body read each arm one watchdog");
    assert.equal(clearedWatchdogTimers, 2, "early break clears both response-start and body watchdog timers");
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("surfacesNoProgressTimeoutWhenAnthropicResponseDoesNotStart", async () => {
  // Regression from the investigated stuck session: a body-read timeout is not
  // enough if fetch itself never resolves with response headers. The same
  // no-progress budget must also cover the response-start phase.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    await assert.rejects(
      streamNativeMessagesSseEvents(
        requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
        { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`], streamNoProgressTimeoutMs: 25 },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /made no progress for 25ms before response started/);
        assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("defaultResponseStartTimeoutIsLongerThanStreamBodyNoProgressTimeout", async () => {
  // Regression from a false-positive Opus 4.7 timeout: Anthropic can take more
  // than the in-stream SSE ping budget before sending response headers, because
  // it cannot emit ping events until the HTTP response has started.
  assert.ok(
    DEFAULT_RESPONSE_START_TIMEOUT_MS > DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS,
    "response-start watchdog must be less aggressive than the stream-body watchdog",
  );

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduledDelays: number[] = [];

  try {
    globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof delay === "number") scheduledDelays.push(delay);
      queueMicrotask(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    await assert.rejects(
      streamNativeMessagesSseEvents(
        requestForMockedAnthropicFetch({ accessToken: FAKE_TOKEN, payload: { stream: true } }),
        { knownSecrets: [FAKE_TOKEN, `Bearer ${FAKE_TOKEN}`] },
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, new RegExp(`made no progress for ${DEFAULT_RESPONSE_START_TIMEOUT_MS}ms before response started`));
        assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
        return true;
      },
    );

    assert.deepEqual(scheduledDelays, [DEFAULT_RESPONSE_START_TIMEOUT_MS]);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("preservesNonToolBlocksWhenStreamFailsAfterMixedContent", async () => {
  // Errored assistant messages keep text/thinking content so Pi can show what
  // was produced; only the partial tool_use is dropped because it is not safe
  // to expose as an executable-looking tool call.
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: requestFrom,
    streamRequest: async () => (async function* () {
      yield { type: "messageStart", responseId: "msg_partial", model: "claude-sonnet-4-6" } as AnthropicSseEvent;
      yield { type: "textStart", index: 0, text: "" } as AnthropicSseEvent;
      yield { type: "textDelta", index: 0, text: "Calling edit..." } as AnthropicSseEvent;
      yield { type: "contentBlockStop", index: 0 } as AnthropicSseEvent;
      yield { type: "toolUseStart", index: 1, id: "toolu_edit", name: "edit", input: {} } as AnthropicSseEvent;
      yield { type: "toolUseInputDelta", index: 1, partialJson: '{"path":"/tmp/x"' } as AnthropicSseEvent;
      throw new Error("terminated; cause: UND_ERR_SOCKET: other side closed");
    })(),
    now: () => 1234567890,
  });

  const events = await collectEvents(streamSimple(model(), context()));
  const error = lastErrorEvent(events);

  assert.equal(error.reason, "error");
  assert.equal(
    error.error.content.some((block) => block.type === "toolCall"),
    false,
    "toolCall block must be dropped",
  );
  const textBlocks = error.error.content.filter((block) => block.type === "text");
  assert.equal(textBlocks.length, 1, "text block must be preserved");
  assert.equal((textBlocks[0] as { text: string }).text, "Calling edit...");
});

// --- Native microcompaction wiring -------------------------------------------

const MICROCOMPACT_BIG = "x".repeat(5000);

function createMicrocompactionHarness(
  parserEvents: AnthropicSseEvent[],
  microcompactionConfig: NativeMicrocompactionConfig,
) {
  const buildRequestCalls: BuildRequestCall[] = [];
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      buildRequestCalls.push(input);
      return requestFrom(input);
    },
    streamRequest: async () => "mock-sse",
    parseSse: () => parserEvents,
    now: () => 1234567890,
    microcompactionConfig: () => microcompactionConfig,
  });
  return { streamSimple, buildRequestCalls };
}

function microcompactionMessages(): Message[] {
  const messages: Message[] = [];
  for (const id of ["a", "b", "c"]) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `toolu_${id}`, name: "read", arguments: { path: id } }],
      api: SUBSCRIPTION_NATIVE_API_ID,
      provider: PROVIDER_ID,
      model: "claude-sonnet-4-6",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    });
    messages.push({
      role: "toolResult",
      toolCallId: `toolu_${id}`,
      toolName: "read",
      content: [{ type: "text", text: MICROCOMPACT_BIG }],
      isError: false,
      timestamp: 1,
    });
  }
  return messages;
}

function payloadToolResults(payloadMessages: unknown): Array<{ tool_use_id: string; content: unknown }> {
  const out: Array<{ tool_use_id: string; content: unknown }> = [];
  for (const message of payloadMessages as Array<{ role: string; content: unknown }>) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result") out.push({ tool_use_id: block.tool_use_id as string, content: block.content });
    }
  }
  return out;
}

test("microcompaction is a no-op when disabled and sends full tool results", async () => {
  resetNativeMicrocompactionTelemetry();
  const { streamSimple, buildRequestCalls } = createMicrocompactionHarness(
    successfulTextEvents("msg_mc_disabled"),
    disabledMicrocompactionConfig(),
  );

  const events = await collectEvents(streamSimple(model(), { messages: microcompactionMessages() }));
  assert.equal(events.at(-1)?.type, "done");

  const results = payloadToolResults(buildRequestCalls[0].payload.messages);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.content === MICROCOMPACT_BIG), "disabled microcompaction must not clear content");
  // Disabled requests are not recorded in microcompaction telemetry.
  assert.equal(getNativeMicrocompactionTelemetrySnapshot().totals.requests, 0);
});

test("microcompaction clears old tool results, keeps recent, and preserves tool invariants", async () => {
  resetNativeMicrocompactionTelemetry();
  const { streamSimple, buildRequestCalls } = createMicrocompactionHarness(
    successfulTextEvents("msg_mc_enabled"),
    { enabled: true, keepRecent: 1, minBytesSaved: 1 },
  );

  const events = await collectEvents(streamSimple(model(), { messages: microcompactionMessages() }));
  assert.equal(events.at(-1)?.type, "done");

  const payloadMessages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  const results = payloadToolResults(payloadMessages);
  assert.deepEqual(results.map((r) => r.content), [
    TOOL_RESULT_CLEARED_PLACEHOLDER,
    TOOL_RESULT_CLEARED_PLACEHOLDER,
    MICROCOMPACT_BIG,
  ]);

  // Invariant: every assistant tool_use id has a matching tool_result, and the
  // placeholder only ever appears inside tool_result content.
  const toolUseIds: string[] = [];
  for (const message of payloadMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use") toolUseIds.push(block.id as string);
    }
  }
  const resultIds = results.map((r) => r.tool_use_id);
  assert.deepEqual(resultIds.sort(), toolUseIds.sort());

  const assistantText = JSON.stringify(payloadMessages.filter((m) => m.role === "assistant"));
  assert.ok(!assistantText.includes(TOOL_RESULT_CLEARED_PLACEHOLDER), "placeholder must not leak into assistant content");

  const totals = getNativeMicrocompactionTelemetrySnapshot().totals;
  assert.equal(totals.requests, 1);
  assert.equal(totals.appliedRequests, 1);
  assert.equal(totals.compactedResults, 2);
  assert.ok(totals.bytesSaved > 9000);
});

test("microcompaction over a parallel tool-call turn keeps every tool_use answered", async () => {
  resetNativeMicrocompactionTelemetry();
  const { streamSimple, buildRequestCalls } = createMicrocompactionHarness(
    successfulTextEvents("msg_mc_parallel"),
    { enabled: true, keepRecent: 1, minBytesSaved: 1 },
  );

  const parallelAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "toolu_p1", name: "read", arguments: { path: "p1" } },
      { type: "toolCall", id: "toolu_p2", name: "read", arguments: { path: "p2" } },
    ],
    api: SUBSCRIPTION_NATIVE_API_ID,
    provider: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const messages: Message[] = [
    parallelAssistant,
    { role: "toolResult", toolCallId: "toolu_p1", toolName: "read", content: [{ type: "text", text: MICROCOMPACT_BIG }], isError: false, timestamp: 1 },
    { role: "toolResult", toolCallId: "toolu_p2", toolName: "read", content: [{ type: "text", text: MICROCOMPACT_BIG }], isError: false, timestamp: 2 },
  ];

  const events = await collectEvents(streamSimple(model(), { messages }));
  assert.equal(events.at(-1)?.type, "done");

  const payloadMessages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  const toolUseIds: string[] = [];
  for (const message of payloadMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use") toolUseIds.push(block.id as string);
    }
  }
  const results = payloadToolResults(payloadMessages);
  // Both parallel tool_use ids must still have a matching tool_result even though
  // the older one (p1) was cleared and the recent one (p2) kept full.
  assert.deepEqual(results.map((r) => r.tool_use_id).sort(), toolUseIds.sort());
  assert.deepEqual(results.map((r) => r.content), [TOOL_RESULT_CLEARED_PLACEHOLDER, MICROCOMPACT_BIG]);
});

test("microcompaction through the real request builder still lands prompt-cache anchors", async () => {
  resetNativeMicrocompactionTelemetry();
  const requests: NativeMessagesRequest[] = [];
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      const request = buildNativeMessagesRequest(input);
      requests.push(request);
      return request;
    },
    streamRequest: async () => "mock-sse",
    parseSse: () => successfulTextEvents("msg_mc_real_request"),
    now: () => 1234567890,
    microcompactionConfig: () => ({ enabled: true, keepRecent: 1, minBytesSaved: 1 }),
  });

  const events = await collectEvents(streamSimple(model(), {
    systemPrompt: "Pi system prompt",
    messages: microcompactionMessages(),
  }));
  assert.equal(events.at(-1)?.type, "done");

  const body = requests[0].body as {
    system: Array<{ type: string; text: string; cache_control?: unknown }>;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ cache_control?: unknown }>;
  };

  // Microcompaction still applied through the real builder.
  const results = payloadToolResults(body.messages);
  assert.deepEqual(results.map((r) => r.content), [
    TOOL_RESULT_CLEARED_PLACEHOLDER,
    TOOL_RESULT_CLEARED_PLACEHOLDER,
    MICROCOMPACT_BIG,
  ]);

  // System identity block keeps its cache anchor.
  assert.deepEqual(body.system[0].cache_control, EPHEMERAL_CACHE_CONTROL);

  // The last user message (the kept, recent tool_result turn) still carries the
  // trailing cache anchor on its last content block.
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  assert.ok(lastUser && Array.isArray(lastUser.content));
  const lastBlock = (lastUser.content as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(lastBlock?.cache_control, EPHEMERAL_CACHE_CONTROL);

  assert.equal(getNativeMicrocompactionTelemetrySnapshot().totals.appliedRequests, 1);
});
