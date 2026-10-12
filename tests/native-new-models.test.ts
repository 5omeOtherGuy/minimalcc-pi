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
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
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

// Models that carry a server-side refusal fallback, keyed by fallback target.
const REFUSAL_FALLBACKS: Record<string, string> = {
  "claude-fable-5-1": "claude-opus-5",
};
// Models whose thinking cannot be turned off: Pi hides `off`.
const ALWAYS_THINKING = new Set(["claude-opus-5-5", "claude-fable-5-1"]);

for (const id of ["claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
  const fallbackModel = REFUSAL_FALLBACKS[id];
  test(`${id} keeps subscription metadata and zero API cost`, () => {
    const model = registeredModel(id);
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(
      getSupportedThinkingLevels(model),
      [...(ALWAYS_THINKING.has(id) ? [] : ["off"]), "minimal", "low", "medium", "high", "xhigh", "max"],
    );
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
      assert.equal((payload.tools as unknown[]).length, 1);
      if (fallbackModel) {
        assert.deepEqual(payload.fallbacks, [{ model: fallbackModel }]);
      } else {
        assert.ok(!("fallbacks" in payload));
      }
    });
  }

  test(`${id} handles a request without a reasoning level`, () => {
    const payload = contextToPayload(registeredModel(id), context, { temperature: 0.3 });
    if (ALWAYS_THINKING.has(id)) {
      // Never let the server default effort stand in for "off".
      assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(payload.output_config, { effort: "low" });
    } else if (id === "claude-sonnet-5-5" || id === "claude-haiku-5-5") {
      assert.deepEqual(payload.thinking, { type: id === "claude-sonnet-5-5" ? "between_tools" : "disabled" });
      assert.deepEqual(payload.output_config, { effort: "low" });
    } else {
      assert.ok(!("thinking" in payload));
      assert.ok(!("output_config" in payload));
    }
    assert.ok(!("temperature" in payload));
    assert.ok(!("tool_choice" in payload));
    if (fallbackModel) {
      assert.deepEqual(payload.fallbacks, [{ model: fallbackModel }]);
    } else {
      assert.ok(!("fallbacks" in payload));
    }
    const request = buildNativeMessagesRequest({ accessToken: "fake-new-model-oauth-token", payload });
    assert.equal(request.headers["anthropic-beta"].split(",").includes(SERVER_SIDE_FALLBACK_BETA), fallbackModel !== undefined);
    assert.ok(!("x-api-key" in request.headers));
  });

  if (id !== "claude-opus-5") {
    test(`${id} respects synchronous output limits and ignores manual budgets`, () => {
      for (const [maxTokens, expected] of [[8192, 8192], [300000, 128000]] as const) {
        const payload = contextToPayload(registeredModel(id), context, {
          reasoning: "max", maxTokens, thinkingBudgets: { high: 2048 },
        });
        assert.equal(payload.max_tokens, expected);
        assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
        assert.deepEqual(payload.output_config, { effort: "max" });
      }
    });
  }
}
