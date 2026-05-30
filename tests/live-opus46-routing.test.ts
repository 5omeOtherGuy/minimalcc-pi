import assert from "node:assert/strict";
import test from "node:test";

import claudeSubscriptionExtension from "../extensions/minimalcc-pi/index.ts";

const PROVIDER_ID = "claude-subscription";
const OPUS_46_MODEL_ID = "claude-opus-4-6";
const OPUS_48_MODEL_ID = "claude-opus-4-8";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const LIVE_OPUS46_TEST_ENABLED = process.env.PI_LIVE_CLAUDE_OPUS46_TEST === "1";
const LIVE_OPUS46_TEST_SKIP_REASON = LIVE_OPUS46_TEST_ENABLED
  ? false
  : "set PI_LIVE_CLAUDE_OPUS46_TEST=1 to make a live Claude Code OAuth request";
const LIVE_OPUS48_TOOL_TEST_ENABLED = process.env.PI_LIVE_CLAUDE_OPUS48_TOOL_TEST === "1";
const LIVE_OPUS48_TOOL_TEST_SKIP_REASON = LIVE_OPUS48_TOOL_TEST_ENABLED
  ? false
  : "set PI_LIVE_CLAUDE_OPUS48_TOOL_TEST=1 to make a live Opus 4.8 tool-use request";

function loadProvider(): any {
  let provider: any;
  claudeSubscriptionExtension({
    registerProvider(id: string, config: unknown) {
      if (id === PROVIDER_ID) provider = config;
    },
    unregisterProvider() {},
    on() {},
    registerCommand() {},
  } as any);

  assert.ok(provider, "extension should register claude-subscription provider");
  return provider;
}

async function collectStreamEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function urlFromFetchInput(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerKeys(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.keys()].map((key) => key.toLowerCase());
  if (Array.isArray(headers)) return headers.map(([key]) => key.toLowerCase());
  return Object.keys(headers).map((key) => key.toLowerCase());
}

test("live Opus 4.6 selection is honored by Anthropic response model", {
  skip: LIVE_OPUS46_TEST_SKIP_REASON,
  timeout: 120_000,
}, async () => {
  const originalFetch = globalThis.fetch;
  assert.equal(typeof originalFetch, "function", "global fetch is required for live verification");

  const provider = loadProvider();
  const registeredModel = provider.models.find((candidate: { id: string }) => candidate.id === OPUS_46_MODEL_ID);
  assert.ok(registeredModel, "extension must register Opus 4.6");

  let capturedBody: Record<string, unknown> | undefined;
  let capturedHeaderKeys: string[] = [];

  try {
    globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const [input, init] = args;
      if (urlFromFetchInput(input) === ANTHROPIC_MESSAGES_URL) {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        capturedHeaderKeys = headerKeys(init?.headers);
      }
      return originalFetch(...args);
    }) as typeof fetch;

    const selectedModel = {
      ...registeredModel,
      provider: PROVIDER_ID,
      baseUrl: provider.baseUrl,
    };

    const events = await collectStreamEvents(provider.streamSimple(selectedModel, {
      systemPrompt: "You are verifying Claude model routing. Keep the answer short.",
      messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
    }, {
      maxTokens: 16,
      timeoutMs: 120_000,
    }));

    const error = events.find((event) => event.type === "error");
    if (error) assert.fail(error.error?.errorMessage ?? "live Claude subscription stream errored");

    assert.equal(capturedBody?.model, OPUS_46_MODEL_ID, "extension must send Opus 4.6 in the live request body");
    assert.ok(!capturedHeaderKeys.includes("x-api-key"), "live request must not send x-api-key");
    assert.ok(!capturedHeaderKeys.includes("anthropic-api-key"), "live request must not send Anthropic API-key aliases");

    const done = events.at(-1);
    assert.equal(done?.type, "done", "live stream should complete successfully");
    const responseModel = done.message.responseModel;
    assert.equal(typeof responseModel, "string", "live response should include Anthropic response model");
    assert.match(
      responseModel,
      /^claude-opus-4-6(?:$|[-.])/,
      "Anthropic response model should confirm Opus 4.6 rather than a fallback model",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live Opus 4.8 accepts standard Anthropic tool schema", {
  skip: LIVE_OPUS48_TOOL_TEST_SKIP_REASON,
  timeout: 120_000,
}, async () => {
  const originalFetch = globalThis.fetch;
  assert.equal(typeof originalFetch, "function", "global fetch is required for live verification");

  const provider = loadProvider();
  const registeredModel = provider.models.find((candidate: { id: string }) => candidate.id === OPUS_48_MODEL_ID);
  assert.ok(registeredModel, "extension must register Opus 4.8");

  let capturedBody: Record<string, unknown> | undefined;
  let capturedAnthropicBeta = "";

  try {
    globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const [input, init] = args;
      if (urlFromFetchInput(input) === ANTHROPIC_MESSAGES_URL) {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAnthropicBeta = headers?.["anthropic-beta"] ?? headers?.["Anthropic-Beta"] ?? "";
      }
      return originalFetch(...args);
    }) as typeof fetch;

    const selectedModel = {
      ...registeredModel,
      provider: PROVIDER_ID,
      baseUrl: provider.baseUrl,
    };

    const events = await collectStreamEvents(provider.streamSimple(selectedModel, {
      systemPrompt: "You are verifying Anthropic tool-use wire compatibility. Use tools when asked.",
      messages: [{ role: "user", content: "Use the bash tool to run exactly: printf PI_TOOL_OK", timestamp: 0 }],
      tools: [{
        name: "bash",
        description: "Run shell commands",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }],
    }, {
      maxTokens: 1024,
      reasoning: "low",
      timeoutMs: 120_000,
    }));

    const error = events.find((event) => event.type === "error");
    if (error) assert.fail(error.error?.errorMessage ?? "live Claude subscription tool stream errored");

    assert.equal(capturedBody?.model, OPUS_48_MODEL_ID, "extension must send Opus 4.8 in the live request body");
    assert.deepEqual(capturedBody?.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.ok(!JSON.stringify(capturedBody?.tools).includes("eager_input_streaming"), "tool schema must not request eager input streaming");
    assert.ok(!capturedAnthropicBeta.includes("fine-grained-tool-streaming"), "headers must not request fine-grained tool streaming");

    const toolEnd = events.find((event) => event.type === "toolcall_end");
    assert.ok(toolEnd, "live Opus 4.8 should emit a completed tool_use block for this prompt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
