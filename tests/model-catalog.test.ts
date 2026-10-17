import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

import { createClaudeModelCatalog } from "../src/model-catalog.ts";
import { MODELS } from "../src/models.ts";

const context = (allowNetwork = true): RefreshModelsContext => ({
  allowNetwork, signal: new AbortController().signal, publish: async () => true,
});

test("Claude catalog uses OAuth headers, paginates, and maps new models", async () => {
  const urls: string[] = [];
  const refresh = createClaudeModelCatalog(async (url, init) => {
    urls.push(url);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer fake-token");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.ok(init.signal);
    return Response.json(urls.length === 1
      ? { data: [{ id: "claude-new-1", display_name: "Claude New", max_input_tokens: 300_000, max_tokens: 80_000,
          capabilities: { image_input: { supported: true }, effort: { low: { supported: true }, high: { supported: true } },
            thinking: { types: { adaptive: { supported: true }, disabled: { supported: false } } } } }],
        has_more: true, last_id: "cursor-1" }
      : { data: [{ id: "other-model", display_name: "Other", max_input_tokens: 1000, max_tokens: 1000 }], has_more: false });
  }, async () => "fake-token");
  const models = await refresh(context());
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).searchParams.get("after_id"), "cursor-1");
  assert.deepEqual(models.map((model) => model.id), ["claude-new-1"]);
  assert.equal(models[0]?.contextWindow, 300_000);
  assert.equal(models[0]?.maxTokens, 80_000);
  assert.equal(models[0]?.reasoning, true);
  assert.equal(models[0]?.thinkingLevelMap?.off, null);
  assert.deepEqual(models[0]?.input, ["text", "image"]);
});

test("Claude catalog preserves known compatibility and local soft-cap aliases", async () => {
  const refresh = createClaudeModelCatalog(async () => Response.json({ data: [
    { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  ], has_more: false }), async () => "fake-token");
  const models = await refresh(context());
  assert.deepEqual(models.map((model) => model.id), ["claude-opus-4-7", "claude-opus-4-7-300k"]);
  assert.deepEqual(models[0]?.thinkingLevelMap, MODELS.find((model) => model.id === "claude-opus-4-7")?.thinkingLevelMap);
});

test("Claude catalog falls back offline, on failed pages and malformed payloads", async () => {
  let calls = 0;
  const refresh = createClaudeModelCatalog(async () => { calls++; throw new Error("offline"); }, async () => "fake-token");
  assert.deepEqual(await refresh(context(false)), [...MODELS]);
  assert.equal(calls, 0);
  assert.deepEqual(await refresh(context()), [...MODELS]);
  for (const response of [new Response("denied", { status: 401 }), Response.json({ data: [], has_more: true }), Response.json({ data: [] })]) {
    assert.deepEqual(await createClaudeModelCatalog(async () => response, async () => "fake-token")(context()), [...MODELS]);
  }
});
