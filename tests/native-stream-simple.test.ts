import assert from "node:assert/strict";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { AnthropicSseEvent } from "../src/anthropic-sse.ts";
import { CLAUDE_CODE_IDENTITY } from "../src/constants.ts";
import { getNativeCacheDiagnosticsSnapshot, resetNativeCacheDiagnostics } from "../src/native-cache-diagnostics.ts";
import { buildNativeMessagesRequest, type NativeMessagesRequest, type NativeMessagesRequestInput } from "../src/native-request.ts";
import { createNativeStreamSimple, streamNativeMessagesSse, streamNativeMessagesSseEvents } from "../src/native-stream-simple.ts";
import { getNativeUsageTelemetrySnapshot, resetNativeUsageTelemetry } from "../src/native-usage-telemetry.ts";

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
  return {
    url: "mock://anthropic/messages",
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    body: input.payload,
  };
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
    assert.match(events[1].error.errorMessage ?? "", new RegExp(provider), provider);
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
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "bash",
      description: "Run shell commands",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      cache_control: EPHEMERAL_CACHE_CONTROL,
    },
  ]);
  assert.ok(!requests[0].headers["anthropic-beta"].includes("fine-grained-tool-streaming-2025-05-14"));
});

test("fallsBackToFineGrainedToolStreamingBetaWhenEagerInputStreamingUnsupported", async () => {
  const { streamSimple, requests } = createRealRequestHarness(successfulTextEvents("msg_legacy_tool_streaming"));

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
  assert.ok(requests[0].headers["anthropic-beta"].includes("fine-grained-tool-streaming-2025-05-14"));
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
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "toolu_screenshot",
    toolName: "screenshot",
    content: [
      { type: "text", text: "Screenshot captured." },
      { type: "image", mimeType: "image/jpeg", data: "/9j/fakeJpegData" },
    ],
    isError: false,
    timestamp: 0,
  };

  const events = await collectEvents(streamSimple(model(), { messages: [toolResult] }));

  assert.equal(events.at(-1)?.type, "done");
  const messages = buildRequestCalls[0].payload.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  const outerContent = messages[0].content as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
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

  const events = await collectEvents(streamSimple(model(), {
    messages: [
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
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_one", content: "one", is_error: false },
      { type: "tool_result", tool_use_id: "toolu_two", content: "two", is_error: true },
    ],
  }]);
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
      { type: "tool_use", id: "call_invalid_foreign", name: "bash", input: { command: "git status" } },
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

test("uses adaptive thinking only for Opus 4.7 and maps Pi xhigh to Claude xhigh", async () => {
  const expectedEfforts = new Map([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
  ] as const);

  for (const [reasoning, effort] of expectedEfforts) {
    const { streamSimple, buildRequestCalls } = createHarness([
      { type: "messageStart", responseId: `msg_${reasoning}`, model: "claude-opus-4-7" },
      { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
      { type: "messageStop", stopReason: "end_turn" },
    ]);

    await collectEvents(streamSimple(
      model("claude-opus-4-7", {
        thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
      }),
      context(),
      { reasoning, temperature: 0.3 },
    ));

    assert.equal(buildRequestCalls.length, 1, reasoning);
    assert.deepEqual(buildRequestCalls[0].payload.thinking, { type: "adaptive", display: "summarized" }, reasoning);
    assert.deepEqual(buildRequestCalls[0].payload.output_config, { effort }, reasoning);
    assert.ok(!("temperature" in buildRequestCalls[0].payload), reasoning);
  }
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
    { partialJson: "[]", expectedArguments: {} },
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

    const body = await streamNativeMessagesSse(requestFrom({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
      onResponse: async (response) => { hookResponse = response; },
    });

    assert.match(body, /message_stop/);
    assert.deepEqual(hookResponse, { status: 200, headers: { "content-type": "text/plain;charset=UTF-8", "request-id": "req_hook" } });
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
      () => streamNativeMessagesSse(requestFrom({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
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

    for await (const event of await streamNativeMessagesSseEvents(requestFrom({ accessToken: FAKE_TOKEN, payload: { stream: true } }), {
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

  const events = await collectEvents(streamSimple(model("claude-opus-4-7"), {
    messages: [mixedAssistantMessage],
  }));

  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(buildRequestCalls[0].payload.messages, [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should call bash.", signature: "sig-abc" },
      { type: "text", text: "Let me run that." },
      { type: "tool_use", id: "toolu_xyz", name: "bash", input: { command: "ls" } },
    ],
  }]);
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
