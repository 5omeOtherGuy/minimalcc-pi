import assert from "node:assert/strict";
import test from "node:test";

import claudeSubscriptionExtension from "../extensions/minimalcc-pi/index.ts";

// Opt-in live verification of the Claude Opus 5.5 request surface over the
// Claude Code OAuth subscription lane. Skipped unless explicitly enabled.

const PROVIDER_ID = "claude-subscription";
const OPUS_5_5_MODEL_ID = "claude-opus-5-5";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const LIVE_OPUS55_TEST_SKIP_REASON = process.env.PI_LIVE_CLAUDE_OPUS55_TEST === "1"
  ? false
  : "set PI_LIVE_CLAUDE_OPUS55_TEST=1 to make live Claude Opus 5.5 OAuth requests";

const BASH_TOOL = {
  name: "bash",
  description: "Run shell commands",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

function loadOpus55(): { provider: any; model: any } {
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
  const registered = provider.models.find((candidate: { id: string }) => candidate.id === OPUS_5_5_MODEL_ID);
  assert.ok(registered, "extension must register Opus 5.5");
  return { provider, model: { ...registered, provider: PROVIDER_ID, baseUrl: provider.baseUrl } };
}

type Captured = { body?: Record<string, any>; headerKeys: string[]; anthropicBeta: string };

async function streamCapturing(provider: any, model: any, context: unknown, options: unknown): Promise<{ events: any[]; captured: Captured }> {
  const originalFetch = globalThis.fetch;
  const captured: Captured = { headerKeys: [], anthropicBeta: "" };
  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === ANTHROPIC_MESSAGES_URL) {
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.headerKeys = Object.keys(headers).map((key) => key.toLowerCase());
      captured.anthropicBeta = headers["anthropic-beta"] ?? "";
    }
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    const events: any[] = [];
    for await (const event of provider.streamSimple(model, context, options)) events.push(event);
    const error = events.find((event) => event.type === "error");
    if (error) assert.fail(error.error?.errorMessage ?? "live Claude Opus 5.5 stream errored");
    return { events, captured };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertOpus55Request(captured: Captured, effort: string): void {
  assert.equal(captured.body?.model, OPUS_5_5_MODEL_ID);
  assert.deepEqual(captured.body?.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(captured.body?.output_config, { effort });
  assert.ok(!("fallbacks" in (captured.body ?? {})), "Opus 5.5 must not send a refusal fallback");
  assert.ok(!captured.anthropicBeta.includes("server-side-fallback"), "Opus 5.5 must not send the fallback beta");
  assert.ok(!("tool_choice" in (captured.body ?? {})), "forced tool_choice 400s on Opus 5.5");
  assert.ok(!captured.headerKeys.includes("x-api-key"), "live request must not send x-api-key");
}

function assertServedByOpus55(done: any): void {
  assert.equal(done?.type, "done", "live stream should complete successfully");
  assert.match(done.message.responseModel ?? "", /^claude-opus-5-5(?:$|[-.@])/, "Anthropic must confirm Opus 5.5 served the turn");
}

test("live Opus 5.5 without a Pi reasoning level sends explicit low effort and is accepted", {
  skip: LIVE_OPUS55_TEST_SKIP_REASON,
  timeout: 180_000,
}, async () => {
  const { provider, model } = loadOpus55();
  const { events, captured } = await streamCapturing(provider, model, {
    systemPrompt: "You are verifying Claude model routing. Keep the answer short.",
    messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
  }, { maxTokens: 2048, timeoutMs: 180_000 });

  assertOpus55Request(captured, "low");
  assertServedByOpus55(events.at(-1));
});

test("live Opus 5.5 tool use round-trips with replayed signed thinking", {
  skip: LIVE_OPUS55_TEST_SKIP_REASON,
  timeout: 300_000,
}, async () => {
  const { provider, model } = loadOpus55();
  const systemPrompt = "You are verifying Anthropic tool-use wire compatibility. Use tools when asked.";
  // A prompt that needs some reasoning, at `high`, so the turn carries a signed
  // thinking block for the replay check below.
  const firstUser = {
    role: "user",
    content: "Work out which of 17*23 and 19*21 is larger, then use the bash tool to run exactly: printf PI_TOOL_OK. After the tool result, reply with the tool output only.",
    timestamp: 0,
  };

  const first = await streamCapturing(provider, model, { systemPrompt, messages: [firstUser], tools: [BASH_TOOL] }, {
    maxTokens: 8192,
    reasoning: "high",
    timeoutMs: 300_000,
  });
  assertOpus55Request(first.captured, "high");
  const firstDone = first.events.at(-1);
  assertServedByOpus55(firstDone);
  const toolCall = firstDone.message.content.find((block: any) => block.type === "toolCall");
  assert.ok(toolCall, "Opus 5.5 should call the bash tool for this prompt");

  // Second turn replays the assistant turn (including any signed thinking)
  // verbatim with the tool result appended; Opus 5.5's preserved-thinking
  // check rejects replayed blocks whose prefix changed.
  const second = await streamCapturing(provider, model, {
    systemPrompt,
    messages: [
      firstUser,
      firstDone.message,
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "PI_TOOL_OK" }],
        isError: false,
        timestamp: 0,
      },
    ],
    tools: [BASH_TOOL],
  }, { maxTokens: 8192, reasoning: "high", timeoutMs: 300_000 });

  assertOpus55Request(second.captured, "high");
  const replayedAssistant = second.captured.body?.messages?.[1];
  const signedThinking = firstDone.message.content.filter((block: any) => block.type === "thinking" && block.thinkingSignature);
  assert.ok(signedThinking.length > 0, "the first turn must carry signed thinking for the replay check to mean anything");
  assert.equal(
    replayedAssistant?.content?.filter((block: any) => block.type === "thinking" || block.type === "redacted_thinking").length,
    signedThinking.length,
    "every signed Opus 5.5 thinking block must be replayed",
  );
  const secondDone = second.events.at(-1);
  assertServedByOpus55(secondDone);
  const text = secondDone.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
  assert.match(text, /PI_TOOL_OK/);
});
