import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MODELS } from "../src/models.ts";

type MatrixRow = {
  id: string;
  nativeModelId: string;
  contextWindow: number;
  maxTokens: number;
  thinkingMode: "adaptive" | "manual";
};

const EXPECTED_MATRIX: MatrixRow[] = [
  { id: "claude-haiku-4-5", nativeModelId: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 64000, thinkingMode: "manual" },
  { id: "claude-sonnet-4-6", nativeModelId: "claude-sonnet-4-6", contextWindow: 200000, maxTokens: 64000, thinkingMode: "manual" },
  { id: "claude-opus-4-6", nativeModelId: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, thinkingMode: "manual" },
  { id: "claude-opus-4-7", nativeModelId: "claude-opus-4-7", contextWindow: 1000000, maxTokens: 128000, thinkingMode: "adaptive" },
  { id: "claude-opus-4-7-300k", nativeModelId: "claude-opus-4-7", contextWindow: 300000, maxTokens: 128000, thinkingMode: "adaptive" },
  { id: "claude-opus-4-8", nativeModelId: "claude-opus-4-8", contextWindow: 1000000, maxTokens: 128000, thinkingMode: "adaptive" },
  { id: "claude-fable-5", nativeModelId: "claude-fable-5", contextWindow: 1000000, maxTokens: 128000, thinkingMode: "adaptive" },
];

function compatOf(model: (typeof MODELS)[number]): Record<string, unknown> | undefined {
  return (model as { compat?: Record<string, unknown> }).compat;
}

test("model constants match the documented compatibility matrix", () => {
  const actual: MatrixRow[] = MODELS.map((model) => {
    const compat = compatOf(model);
    const nativeModelId = typeof compat?.nativeModelId === "string" ? compat.nativeModelId : model.id;
    const thinkingMode = compat?.forceAdaptiveThinking === true ? "adaptive" : "manual";
    return {
      id: model.id,
      nativeModelId,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingMode,
    };
  });

  assert.deepEqual(actual, EXPECTED_MATRIX);
});

test("only the soft-cap alias diverges between Pi id and native model id", () => {
  for (const row of EXPECTED_MATRIX) {
    if (row.id === "claude-opus-4-7-300k") {
      assert.equal(row.nativeModelId, "claude-opus-4-7");
    } else {
      assert.equal(row.nativeModelId, row.id);
    }
  }
});

test("docs publish the model compatibility matrix with each model id", () => {
  const status = readFileSync(new URL("../docs/current-status.md", import.meta.url), "utf8");
  assert.match(status, /##\s+Model compatibility matrix/);
  for (const row of EXPECTED_MATRIX) {
    assert.ok(status.includes(row.id), `current-status.md matrix must list ${row.id}`);
  }
  assert.match(status, /claude-opus-4-7-300k.*claude-opus-4-7/s, "matrix must show the 300k soft-cap native alias");
});

test("security threat model documents the core abuse cases without leaking secrets", () => {
  const security = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(security, /##\s+Threat model/);
  for (const expected of [
    "Credential exfiltration",
    "Billing-route confusion",
    "Outbound URL/token exfiltration",
    "Tool-output secret leakage",
    "Malformed or malicious SSE",
    "Destructive automation",
  ]) {
    assert.ok(security.includes(expected), `SECURITY.md threat model must cover ${expected}`);
  }

  for (const pattern of [/sk-ant-/, /Bearer\s+[A-Za-z0-9._-]{10,}/, /ANTHROPIC_API_KEY=/]) {
    assert.ok(!pattern.test(security), `SECURITY.md must not embed a secret-shaped value: ${pattern}`);
  }
});
