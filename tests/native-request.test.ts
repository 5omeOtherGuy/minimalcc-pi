import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_CODE_IDENTITY } from "../src/constants.ts";
import { MODELS } from "../src/models.ts";
import { buildNativeMessagesRequest } from "../src/native-request.ts";

const FAKE_TOKEN = "fake-native-request-oauth-token";
const EXPECTED_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" };

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
    ],
  );
});

test("doesNotIncludeApiKeyHeadersInRequestFixture", () => {
  const request = buildRequest("Pi system prompt");
  const headerKeys = Object.keys(request.headers).map((key) => key.toLowerCase());

  assert.ok(!headerKeys.includes("x-api-key"), "must not include x-api-key");
  assert.ok(!headerKeys.includes("anthropic-api-key"), "must not include API-key aliases");
  assert.deepEqual(Object.keys(request.headers).sort(), [
    "Authorization",
    "Content-Type",
    "anthropic-beta",
    "anthropic-version",
  ]);
});
