import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_CODE_IDENTITY } from "../src/constants.ts";
import { MODELS } from "../src/models.ts";
import { buildNativeMessagesRequest } from "../src/native-request.ts";

const FAKE_TOKEN = "fake-native-request-oauth-token";
const EXPECTED_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" };
const EXPECTED_BASE_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
];
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const FORBIDDEN_STREAMING_BETA_PATTERNS = [
  /fine-grained-tool-streaming/i,
  /token-efficient-tools/i,
  /output-300k-2026-03-24/i,
];
const FORBIDDEN_TOOL_SCHEMA_KEYS = new Set([
  "eager_input_streaming",
  "strict",
  "defer_loading",
]);

function anthropicPayload(system: unknown, model = "claude-sonnet-4-6") {
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system,
  };
}

function buildRequest(system: unknown, model = "claude-sonnet-4-6") {
  return buildNativeMessagesRequest({
    accessToken: FAKE_TOKEN,
    payload: anthropicPayload(system, model),
  });
}

function buildRequestFromPayload(payload: Record<string, unknown>) {
  return buildNativeMessagesRequest({
    accessToken: FAKE_TOKEN,
    payload,
  });
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countCacheControls(item), 0);
  if (!value || typeof value !== "object") return 0;

  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce(
    (count, [key, child]) => count + (key === "cache_control" ? 1 : 0) + countCacheControls(child),
    0,
  );
}

function forbiddenToolSchemaKeys(tool: Record<string, unknown>): string[] {
  return Object.keys(tool).filter((key) => FORBIDDEN_TOOL_SCHEMA_KEYS.has(key));
}

test("constructsNativeMessagesRequestWithRequiredSystemBlocks", () => {
  const request = buildRequest("Pi system prompt");

  assert.equal(request.url, EXPECTED_MESSAGES_URL);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(request.body.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: EPHEMERAL_CACHE_CONTROL },
    { type: "text", text: "Pi system prompt", cache_control: EPHEMERAL_CACHE_CONTROL },
  ]);
  assert.deepEqual(request.body.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello", cache_control: EPHEMERAL_CACHE_CONTROL }],
  }]);
  assert.equal(request.body.model, "claude-sonnet-4-6");
  assert.equal(request.body.max_tokens, 1024);
});

test("doesNotDuplicateClaudeCodeIdentity", () => {
  const request = buildRequest(`${CLAUDE_CODE_IDENTITY}\n\nPi system prompt`);
  const system = request.body.system as Array<{ text: string }>;

  assert.equal(
    system.filter((block) => block.text === CLAUDE_CODE_IDENTITY).length,
    1,
  );
  assert.equal(system[0].text, CLAUDE_CODE_IDENTITY);
  assert.equal(system[1].text, "Pi system prompt");
});

test("addsPromptCachingToLastUserMessageAndLastToolSchema", () => {
  const request = buildRequestFromPayload({
    ...anthropicPayload("Pi system prompt"),
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "user", content: [{ type: "text", text: "last" }] },
    ],
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object" } },
      { name: "bash", description: "Run shell commands", input_schema: { type: "object" } },
    ],
  });

  assert.deepEqual(request.body.messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "middle" }] },
    { role: "user", content: [{ type: "text", text: "last", cache_control: EPHEMERAL_CACHE_CONTROL }] },
  ]);
  assert.deepEqual(request.body.tools, [
    { name: "read", description: "Read files", input_schema: { type: "object" } },
    { name: "bash", description: "Run shell commands", input_schema: { type: "object" }, cache_control: EPHEMERAL_CACHE_CONTROL },
  ]);
});

test("buildsByteStablePayloadsForIdenticalNativeInputs", () => {
  const payload = {
    ...anthropicPayload("Pi system prompt"),
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "user", content: [{ type: "text", text: "last" }] },
    ],
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Run shell commands", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ],
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "low" },
  };

  const first = buildRequestFromPayload(payload);
  const second = buildRequestFromPayload(payload);

  assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
  assert.deepEqual(first.body.tools, [
    { name: "read", description: "Read files", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "bash", description: "Run shell commands", input_schema: { type: "object", properties: { command: { type: "string" } } }, cache_control: EPHEMERAL_CACHE_CONTROL },
  ]);
  assert.deepEqual(first.body.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.deepEqual(first.body.output_config, { effort: "low" });
});

test("preservesExistingCacheControlWhenAddingPromptCaching", () => {
  const identityCacheControl = { type: "ephemeral", ttl: "1h" };
  const promptCacheControl = { type: "ephemeral", ttl: "5m" };
  const messageCacheControl = { type: "ephemeral", ttl: "existing-message" };
  const toolCacheControl = { type: "ephemeral", ttl: "existing-tool" };
  const request = buildRequestFromPayload({
    ...anthropicPayload([
      { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: identityCacheControl },
      { type: "text", text: "Pi system prompt", cache_control: promptCacheControl },
    ]),
    messages: [{
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: messageCacheControl }],
    }],
    tools: [{
      name: "bash",
      description: "Run shell commands",
      input_schema: { type: "object" },
      cache_control: toolCacheControl,
    }],
  });

  assert.deepEqual(request.body.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: identityCacheControl },
    { type: "text", text: "Pi system prompt", cache_control: promptCacheControl },
  ]);
  assert.deepEqual(request.body.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello", cache_control: messageCacheControl }],
  }]);
  assert.deepEqual(request.body.tools, [{
    name: "bash",
    description: "Run shell commands",
    input_schema: { type: "object" },
    cache_control: toolCacheControl,
  }]);
});

test("serializesCurrentModelIds", () => {
  assert.deepEqual(
    MODELS.map((model) => buildRequest("Pi system prompt", model.id).body.model),
    [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-7-300k",
      "claude-opus-4-8",
      "claude-fable-5",
    ],
  );
});

test("snapshotsOAuthOnlyMessagesRequestHeadersAndStreamingBetas", () => {
  const request = buildRequest("Pi system prompt");
  const headerKeys = Object.keys(request.headers).map((key) => key.toLowerCase());

  assert.equal(request.url, EXPECTED_MESSAGES_URL);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(request.headers["anthropic-beta"].split(","), EXPECTED_BASE_BETAS);
  assert.ok(!headerKeys.includes("x-api-key"), "must not include x-api-key");
  assert.ok(!headerKeys.includes("anthropic-api-key"), "must not include API-key aliases");
  assert.deepEqual(Object.keys(request.headers).sort(), [
    "Authorization",
    "Content-Type",
    "anthropic-beta",
    "anthropic-version",
  ]);
  for (const forbidden of FORBIDDEN_STREAMING_BETA_PATTERNS) {
    assert.doesNotMatch(request.headers["anthropic-beta"], forbidden);
  }
});

test("sendsInterleavedThinkingBetaOnlyForManualBudgetThinkingModels", () => {
  // Manual-budget thinking (thinking.type === "enabled") is the only shape that
  // needs the interleaved-thinking beta; adaptive-thinking models imply it
  // server-side, and a request with no thinking does not need it.
  const manualBudget = buildRequestFromPayload({
    ...anthropicPayload("Pi system prompt"),
    thinking: { type: "enabled", budget_tokens: 1024 },
  });
  assert.deepEqual(
    manualBudget.headers["anthropic-beta"].split(","),
    [...EXPECTED_BASE_BETAS, INTERLEAVED_THINKING_BETA],
  );

  const adaptive = buildRequestFromPayload({
    ...anthropicPayload("Pi system prompt"),
    thinking: { type: "adaptive", display: "summarized" },
  });
  assert.deepEqual(adaptive.headers["anthropic-beta"].split(","), EXPECTED_BASE_BETAS);
  assert.ok(!adaptive.headers["anthropic-beta"].includes(INTERLEAVED_THINKING_BETA));

  const noThinking = buildRequest("Pi system prompt");
  assert.deepEqual(noThinking.headers["anthropic-beta"].split(","), EXPECTED_BASE_BETAS);
  assert.ok(!noThinking.headers["anthropic-beta"].includes(INTERLEAVED_THINKING_BETA));
});

test("whitelistsStandardAnthropicToolSchemaFieldsAndSerialToolChoice", () => {
  const request = buildRequestFromPayload({
    ...anthropicPayload("Pi system prompt"),
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object" } },
      { name: "bash", description: "Run shell commands", input_schema: { type: "object" } },
      { name: "write", description: "Write files", input_schema: { type: "object" } },
    ],
  });
  const tools = request.body.tools as Array<Record<string, unknown>>;

  assert.equal(tools.length, 3);
  for (const [index, tool] of tools.entries()) {
    const expectedKeys: string[] = index === tools.length - 1
      ? ["cache_control", "description", "input_schema", "name"]
      : ["description", "input_schema", "name"];
    assert.deepEqual(Object.keys(tool).sort(), expectedKeys);
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.deepEqual(tool.input_schema, { type: "object" });
    assert.deepEqual(forbiddenToolSchemaKeys(tool), []);
  }
  // Parity with Pi's built-in Anthropic provider (and Claude Code 2.1.165): we omit `tool_choice`
  // entirely so Anthropic uses its `auto` default and allows parallel tool calls. Roadmap 3.1
  // reversed 2026-06-08: Pi's harness runs a message's tool calls in parallel by default, and its
  // built-in edit/write tools already serialize same-file mutations via a per-realpath mutation
  // queue that applies regardless of provider, so the forced serial wire flag is no longer kept.
  // Revisit if real parallel-tool-call races appear in practice.
  assert.ok(!("tool_choice" in request.body), "provider omits tool_choice for parallel-tool-use parity");
});

test("capsAnthropicPromptCacheBreakpointsAtFour", () => {
  const request = buildRequestFromPayload({
    ...anthropicPayload("Pi system prompt"),
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "user", content: [{ type: "text", text: "last" }] },
    ],
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object" } },
      { name: "bash", description: "Run shell commands", input_schema: { type: "object" } },
    ],
  });

  assert.equal(countCacheControls(request.body), 4);
});
