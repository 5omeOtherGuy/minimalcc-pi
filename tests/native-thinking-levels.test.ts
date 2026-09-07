import assert from "node:assert/strict";
import test from "node:test";

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

import { CLAUDE_SUBSCRIPTION_NATIVE_API_ID, CLAUDE_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../src/models.ts";
import { contextToPayload, nativeCompat } from "../src/native-payload.ts";

const EXPECTED_EFFORTS = [
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
] as const;
const EXPECTED_BUDGETS = [
  ["minimal", 1024],
  ["low", 4096],
  ["medium", 10240],
  ["high", 20480],
  ["xhigh", 32768],
] as const;
const CONTEXT = { messages: [] };

for (const definition of MODELS) {
  const model: Model<Api> = {
    ...definition,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
  };
  const adaptive = nativeCompat(model)?.forceAdaptiveThinking === true;

  test(`${model.id}: off omits explicit thinking and effort`, () => {
    const payload = contextToPayload(model, CONTEXT);
    assert.equal(payload.thinking, undefined);
    assert.equal(payload.output_config, undefined);
  });

  if (adaptive) {
    test(`${model.id}: Pi exposes native max without shifting lower levels`, () => {
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", ...EXPECTED_EFFORTS.map(([level]) => level)]);
      for (const [level] of EXPECTED_EFFORTS) {
        assert.equal(clampThinkingLevel(model, level), level);
      }
    });

    for (const [reasoning, effort] of EXPECTED_EFFORTS) {
      test(`${model.id}: Pi ${reasoning} sends Claude ${effort}`, () => {
        const payload = contextToPayload(model, CONTEXT, { reasoning });
        assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
        assert.deepEqual(payload.output_config, { effort });
      });
    }
  } else {
    test(`${model.id}: manual levels still stop at xhigh`, () => {
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", ...EXPECTED_BUDGETS.map(([level]) => level)]);
      assert.equal(clampThinkingLevel(model, "max"), "xhigh");
    });

    for (const [reasoning, budget] of EXPECTED_BUDGETS) {
      test(`${model.id}: Pi ${reasoning} preserves its manual budget`, () => {
        const payload = contextToPayload(model, CONTEXT, { reasoning });
        assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: budget });
        assert.equal(payload.output_config, undefined);
      });
    }
  }
}
