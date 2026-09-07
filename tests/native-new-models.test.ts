import assert from "node:assert/strict";
import test from "node:test";

import { getSupportedThinkingLevels, type Api, type Context, type Model } from "@earendil-works/pi-ai";

import { SERVER_SIDE_FALLBACK_BETA } from "../src/constants.ts";
import { CLAUDE_SUBSCRIPTION_NATIVE_API_ID, CLAUDE_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../src/models.ts";
import { contextToPayload, resetServerSideFallbackSupportForTests } from "../src/native-payload.ts";
import { buildNativeMessagesRequest } from "../src/native-request.ts";

const context: Context = {
  systemPrompt: "Test system prompt",
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function registeredModel(id: string): Model<Api> {
  const config = MODELS.find((entry) => entry.id === id);
  assert.ok(config, `${id} must be registered`);
  assert.ok(config.input);
  assert.ok(config.cost);
  assert.ok(config.contextWindow);
  assert.ok(config.maxTokens);
  return {
    ...config,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    reasoning: config.reasoning ?? false,
    input: config.input,
    cost: config.cost,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
}

test.beforeEach(() => resetServerSideFallbackSupportForTests());

for (const id of ["claude-opus-5", "claude-fable-5-1"]) {
  test(`${id} keeps subscription metadata and zero API cost`, () => {
    const model = registeredModel(id);
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  for (const [reasoning, effort] of [
    ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"],
  ] as const) {
    test(`${id} maps ${reasoning} to adaptive ${effort}`, () => {
      const payload = contextToPayload(registeredModel(id), context, { reasoning, temperature: 0.3 });
      assert.equal(payload.model, id);
      assert.equal(payload.max_tokens, 128_000);
      assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(payload.output_config, { effort });
      assert.ok(!("temperature" in payload));
      assert.ok(!("tool_choice" in payload));
      if (id === "claude-fable-5-1") {
        assert.deepEqual(payload.fallbacks, [{ model: "claude-opus-5" }]);
      } else {
        assert.ok(!("fallbacks" in payload));
      }
    });
  }

  test(`${id} omits explicit thinking configuration when reasoning is off`, () => {
    const payload = contextToPayload(registeredModel(id), context, { temperature: 0.3 });
    assert.ok(!("thinking" in payload));
    assert.ok(!("output_config" in payload));
    assert.ok(!("temperature" in payload));
    assert.ok(!("tool_choice" in payload));
    if (id === "claude-fable-5-1") {
      assert.deepEqual(payload.fallbacks, [{ model: "claude-opus-5" }]);
    }
    const request = buildNativeMessagesRequest({ accessToken: "fake-new-model-oauth-token", payload });
    assert.equal(request.headers["anthropic-beta"].split(",").includes(SERVER_SIDE_FALLBACK_BETA), id === "claude-fable-5-1");
    assert.ok(!("x-api-key" in request.headers));
  });
}
