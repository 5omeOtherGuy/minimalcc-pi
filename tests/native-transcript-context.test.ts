import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Context, Model } from "@earendil-works/pi-ai";

import { CLAUDE_SUBSCRIPTION_PROVIDER_ID, MODELS } from "../src/models.ts";
import { contextToPayload, resolveContextSystemPrompt, resolveContextTools } from "../src/native-payload.ts";

// pi >= 0.87 passes providers a TranscriptContext: no `systemPrompt`, no `tools`; the
// prompt and the tool loadout are declared by transcript system messages. Before this
// was handled, every claude-subscription model ran tool-less with an empty system
// prompt (0 tool calls, tool calls faked as text) while built-in providers still worked.

const model = {
  ...MODELS[0],
  provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  baseUrl: "https://api.anthropic.com",
} as Model<Api>;

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const bashTool = {
  name: "bash",
  description: "Run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function transcriptContext(): Context {
  const messages = [
    { role: "system", content: "Pi system prompt.", toolsAdded: [readTool, bashTool], timestamp: 0 },
    { role: "user", content: "List the files.", timestamp: 1 },
    { role: "system", content: "", toolsRemoved: [bashTool], timestamp: 2 },
    { role: "user", content: "Now read README.md.", timestamp: 3 },
  ];
  // The transcript shape is what pi hands over at run time; the cast keeps this test
  // compiling against the devDependency's `Context` type as well.
  return { messages } as unknown as Context;
}

test("transcriptContextDeclaresToolsAndSystemPromptThroughSystemMessages", () => {
  const context = transcriptContext();
  assert.deepEqual((resolveContextTools(context) ?? []).map((tool) => tool.name), ["read"]);
  assert.equal(resolveContextSystemPrompt(context), "Pi system prompt.");

  const payload = contextToPayload(model, context, { reasoning: "high" });
  assert.deepEqual((payload.tools as Array<{ name: string }>).map((tool) => tool.name), ["read"]);
  assert.equal(payload.system, "Pi system prompt.");
  // System messages are never sent as conversation turns.
  assert.deepEqual((payload.messages as Array<{ role: string }>).map((message) => message.role), ["user", "user"]);
});

test("legacyContextFieldsStillWin", () => {
  const context = {
    systemPrompt: "Legacy prompt.",
    tools: [bashTool],
    messages: [
      { role: "system", content: "Transcript prompt.", toolsAdded: [readTool], timestamp: 0 },
      { role: "user", content: "Hi.", timestamp: 1 },
    ],
  } as unknown as Context;
  assert.deepEqual((resolveContextTools(context) ?? []).map((tool) => tool.name), ["bash"]);
  assert.equal(resolveContextSystemPrompt(context), "Legacy prompt.");
});

test("emptyTranscriptYieldsNoToolsAndEmptyPrompt", () => {
  const context = { messages: [{ role: "user", content: "Hi.", timestamp: 1 }] } as unknown as Context;
  assert.equal(resolveContextTools(context), undefined);
  assert.equal(resolveContextSystemPrompt(context), "");
  const payload = contextToPayload(model, context, {});
  assert.equal("tools" in payload, false);
  assert.equal(payload.system, "");
});
