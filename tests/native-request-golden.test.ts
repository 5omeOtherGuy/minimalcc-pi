import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

import type { AnthropicSseEvent } from "../src/anthropic-sse.ts";
import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  MODELS,
} from "../src/models.ts";
import { buildNativeMessagesRequest, type NativeMessagesRequest } from "../src/native-request.ts";
import { createNativeStreamSimple } from "../src/native-stream-simple.ts";

// Full-body golden payload snapshots for every registered model
// (docs/token-efficiency-todos.md item 5 remainder). Section-level cache
// diagnostics catch churn within one section; these snapshots catch any
// cross-cutting byte change to the outgoing Anthropic Messages body. Byte
// stability is a prompt-cache invariant: an unintended body change re-bills
// the entire cached prefix as cache writes on every following turn.
//
// On intended payload changes, regenerate with:
//   PI_GOLDEN_UPDATE=1 node --test --import tsx tests/native-request-golden.test.ts
// and review the golden diff like source code.

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "native-request-bodies.json");
const UPDATE_GOLDEN = process.env.PI_GOLDEN_UPDATE === "1";

const FAKE_TOKEN = "fake-golden-oauth-token";

function registeredModel(config: (typeof MODELS)[number]): Model<Api> {
  // Mirrors what Pi's registerProvider adds to ProviderModelConfig entries.
  return {
    ...config,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
  } as Model<Api>;
}

function successfulTextEvents(responseId: string): AnthropicSseEvent[] {
  return [
    { type: "messageStart", responseId, model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "ok" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ];
}

// One representative agentic round-trip covering every conversion path that
// shapes outgoing bytes: Pi doc-routing sanitization, identity-block shaping,
// tool schemas with the trailing cache anchor, replayed assistant text +
// tool_use (with an id that needs Anthropic-safe remapping), a coalesced
// tool_result turn, and a final user message carrying the moving cache anchor.
function goldenContext(modelId: string): Context {
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Listing the project files." },
      { type: "toolCall", id: "call:7", name: "bash", arguments: { command: "ls" } },
    ],
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  };

  return {
    systemPrompt: "Pi system prompt.\n- When asked about: pi docs, route to docs.\nGeneral guidance.",
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
    messages: [
      { role: "user", content: "List the files.", timestamp: 1 },
      assistantMessage,
      {
        role: "toolResult",
        toolCallId: "call:7",
        toolName: "bash",
        content: [{ type: "text", text: "README.md\nsrc\ntests" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "Now summarize the layout.", timestamp: 4 },
    ],
  };
}

async function captureRequestBody(config: (typeof MODELS)[number]): Promise<Record<string, unknown>> {
  const requests: NativeMessagesRequest[] = [];
  const streamSimple = createNativeStreamSimple({
    loadCredentials: async () => FAKE_TOKEN,
    buildRequest: (input) => {
      const request = buildNativeMessagesRequest(input);
      requests.push(request);
      return request;
    },
    streamRequest: async () => "mock-sse",
    parseSse: () => successfulTextEvents(`msg_golden_${config.id}`),
    now: () => 1234567890,
  });

  const stream = streamSimple(registeredModel(config), goldenContext(config.id), { reasoning: "high" });
  for await (const event of stream) {
    if (event.type === "error") throw new Error(`golden stream errored for ${config.id}`);
  }

  assert.equal(requests.length, 1, `expected exactly one request for ${config.id}`);
  return requests[0].body;
}

function readGolden(): Record<string, unknown> {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;
}

test("fullBodyGoldenPayloadSnapshotsForAllRegisteredModels", async () => {
  const bodies: Record<string, unknown> = {};
  for (const config of MODELS) {
    bodies[config.id] = await captureRequestBody(config);
  }

  if (UPDATE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(bodies, undefined, 2)}\n`);
    return;
  }

  const golden = readGolden();
  assert.deepEqual(
    Object.keys(golden),
    MODELS.map((config) => config.id),
    "golden file must cover exactly the registered models; regenerate with PI_GOLDEN_UPDATE=1",
  );

  for (const config of MODELS) {
    // Byte-level comparison (not deepEqual): JSON.parse preserves key order, so
    // this also fails on pure key-reorder churn that would still break the
    // Anthropic prompt-cache prefix.
    assert.equal(
      JSON.stringify(bodies[config.id]),
      JSON.stringify(golden[config.id]),
      `outgoing Anthropic body bytes changed for ${config.id}; if intended, regenerate with PI_GOLDEN_UPDATE=1 and review the diff`,
    );
  }
});
