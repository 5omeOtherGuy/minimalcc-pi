import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clampThinkingLevel, getApiProvider, getSupportedThinkingLevels, registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai";

import claudeSubscriptionExtension from "../extensions/minimalcc-pi/index.ts";
import {
  MESSAGE_BATCHES_300K_OUTPUT_BETA,
  MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
} from "../src/constants.ts";
import {
  fingerprintNativeRequestShape,
  recordNativeCacheDiagnosticSample,
  resetNativeCacheDiagnostics,
} from "../src/native-cache-diagnostics.ts";
import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID as EXPORTED_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID as EXPORTED_PROVIDER_ID,
  MODELS,
} from "../src/models.ts";
import { recordNativeUsage, resetNativeUsageTelemetry } from "../src/native-usage-telemetry.ts";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROVIDER_ID = "claude-subscription";
const SUBSCRIPTION_NATIVE_API_ID = "claude-subscription-native";
const SHARED_ANTHROPIC_API_ID = "anthropic-messages";
const FAKE_OAUTH_TOKEN = "fake-oauth-token-should-not-leak";
const DUMMY_PI_API_KEY = "dummy-pi-api-key-should-not-leak";
const MESSAGE_BATCHES_OUTPUT_300K_COMPAT = {
  messageBatchesOutputBeta: MESSAGE_BATCHES_300K_OUTPUT_BETA,
  messageBatchesOutputMaxTokens: MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
};

function assertNoSecretLeak(message: string) {
  assert.ok(!message.includes(FAKE_OAUTH_TOKEN), "error should not include OAuth token");
  assert.ok(!message.includes(`Bearer ${FAKE_OAUTH_TOKEN}`), "error should not include bearer token");
  assert.ok(!message.includes(DUMMY_PI_API_KEY), "error should not include Pi API key");
  assert.ok(!message.includes("Authorization"), "error should not include auth header names");
  assert.ok(!message.includes("x-api-key"), "error should not include API-key header names");
  assert.ok(!message.includes("anthropic-api-key"), "error should not include Anthropic API-key header names");
}

type ExtensionContext = {
  model?: { provider?: string };
  ui?: { notify(message: string, level?: string): void };
};
type ProviderRequestHandler = (event: { payload: unknown }, ctx: ExtensionContext) => unknown;

function loadExtension() {
  const providers = new Map<string, unknown>();
  const unregisteredProviders: string[] = [];
  const handlers = new Map<string, Function[]>();

  claudeSubscriptionExtension({
    registerProvider(id: string, config: unknown) {
      providers.set(id, config);
    },
    unregisterProvider(id: string) {
      unregisteredProviders.push(id);
    },
    on(event: string, handler: Function) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand() {},
  } as any);

  const beforeProviderRequest = handlers.get("before_provider_request")?.[0] as ProviderRequestHandler | undefined;
  const input = handlers.get("input")?.[0] as Function | undefined;
  assert.ok(beforeProviderRequest, "extension should register before_provider_request hook");
  assert.ok(input, "extension should register input hook");

  return { providers, unregisteredProviders, beforeProviderRequest, input };
}

function loadExtensionWithCommands() {
  const commands = new Map<string, { description: string; handler: Function }>();

  claudeSubscriptionExtension({
    registerProvider() {},
    unregisterProvider() {},
    on() {},
    registerCommand(name: string, config: { description: string; handler: Function }) {
      commands.set(name, config);
    },
  } as any);

  return commands;
}

function loadExtensionWithApiRegistryBinding() {
  claudeSubscriptionExtension({
    registerProvider(id: string, config: any) {
      if (!config.streamSimple) return;
      registerApiProvider({
        api: config.api,
        stream: config.streamSimple,
        streamSimple: config.streamSimple,
      } as any, `test-provider:${id}`);
    },
    unregisterProvider() {},
    on() {},
    registerCommand() {},
  } as any);
}

function anthropicPayload(system: unknown) {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system,
  };
}

function staleContext(notify: (message: string, level?: string) => void = () => {
  throw new Error("should not notify from stale ctx");
}): any {
  return Object.defineProperty({ ui: { notify } }, "model", {
    get() {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  });
}

async function collectStreamEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function swallowedBeforeProviderRequest(
  handler: ProviderRequestHandler,
  payload: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  let currentPayload = payload;
  try {
    const result = await handler({ payload: currentPayload }, ctx);
    if (result !== undefined) currentPayload = result;
  } catch {
    // Mirrors Pi runner semantics for before_provider_request: emit extension
    // error and continue with the previous payload.
  }
  return currentPayload;
}

test("attempts best-effort unregister of built-in anthropic provider without relying on it for safety", () => {
  const { unregisteredProviders } = loadExtension();

  assert.deepEqual(unregisteredProviders, ["anthropic"]);
});

test("handles input for non-subscription Claude providers before any upstream request", () => {
  const { input } = loadExtension();

  for (const provider of ["anthropic", "custom-anthropic", "meridian"]) {
    const notifications: string[] = [];
    const result = input(
      { text: "hello", images: [], source: "interactive" },
      {
        model: { provider },
        ui: { notify(message: string) { notifications.push(message); } },
      },
    );

    assert.deepEqual(result, { action: "handled" }, provider);
    assert.match(notifications[0], /Blocked Claude provider/, provider);
  }
});

test("skips the provider guard for mid-stream steers and queued follow-ups", () => {
  const { input } = loadExtension();

  for (const streamingBehavior of ["steer", "followUp"] as const) {
    const notifications: string[] = [];
    const result = input(
      { text: "hello", images: [], source: "interactive", streamingBehavior },
      {
        // A blocked provider would normally be handled at idle; mid-stream it must pass
        // through untouched because the in-flight turn already cleared the guard.
        model: { provider: "anthropic" },
        ui: { notify(message: string) { notifications.push(message); } },
      },
    );

    assert.deepEqual(result, { action: "continue" }, streamingBehavior);
    assert.equal(notifications.length, 0, `${streamingBehavior} must not notify`);
  }
});

test("allowsInputWhenProviderIsUndefinedOrModelIsMissing", () => {
  const { input } = loadExtension();
  const notifications: string[] = [];

  const undefinedProviderResult = input(
    { text: "hello", images: [], source: "interactive" },
    {
      model: { provider: undefined },
      ui: { notify(message: string) { notifications.push(message); } },
    },
  );

  const noModelResult = input(
    { text: "hello", images: [], source: "interactive" },
    { ui: { notify(message: string) { notifications.push(message); } } },
  );

  assert.deepEqual(undefinedProviderResult, { action: "continue" });
  assert.deepEqual(noModelResult, { action: "continue" });
  assert.equal(notifications.length, 0, "undefined provider/no model must not notify");
});

test("diagnoses non-subscription Claude providers if provider request hook is reached", () => {
  const { beforeProviderRequest } = loadExtension();
  const payload = anthropicPayload("Pi system prompt");

  for (const provider of ["anthropic", "custom-anthropic", "meridian"]) {
    assert.throws(
      () => beforeProviderRequest({ payload }, { model: { provider } }),
      /Blocked Claude provider/,
      provider,
    );
  }
});

test("handles input fail-closed when session replacement makes the extension ctx stale", () => {
  const { input } = loadExtension();
  const notifications: string[] = [];

  const result = input(
    { text: "hello", images: [], source: "interactive" },
    staleContext((message) => notifications.push(message)),
  );

  assert.deepEqual(result, { action: "handled" });
  assert.match(notifications[0], /Unable to verify Claude provider/);
  assertNoSecretLeak(notifications[0]);
});

test("fails closed for stale Claude-shaped provider payload without leaking secrets", () => {
  const { beforeProviderRequest } = loadExtension();
  const payload = anthropicPayload(
    `Pi system prompt ${FAKE_OAUTH_TOKEN} Bearer ${FAKE_OAUTH_TOKEN} ${DUMMY_PI_API_KEY} Authorization x-api-key anthropic-api-key`,
  );

  assert.throws(
    () => beforeProviderRequest({ payload }, staleContext()),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Unable to verify Claude provider/);
      assertNoSecretLeak(message);
      return true;
    },
  );
});

test("leaves stale non-Claude-shaped provider payload unchanged", () => {
  const { beforeProviderRequest } = loadExtension();
  const payload = { provider: "openai-codex", prompt: "hello" };

  const result = beforeProviderRequest({ payload }, staleContext());

  assert.equal(result, undefined);
});

test("documents swallowed before_provider_request runner semantics", async () => {
  const payload = anthropicPayload("Pi system prompt");

  const result = await swallowedBeforeProviderRequest(
    () => {
      throw new Error(`Blocked Authorization: Bearer ${FAKE_OAUTH_TOKEN}`);
    },
    payload,
    { model: { provider: "anthropic" } },
  );

  assert.equal(result, payload);
});

test("input guard blocks blocked or stale Claude requests before swallowed hook auth credentials and network", async () => {
  const { input, beforeProviderRequest } = loadExtension();
  const payload = anthropicPayload("Pi system prompt");
  const scenarios = [
    { name: "anthropic", ctxProvider: "anthropic", expected: /Blocked Claude provider/ },
    { name: "custom-anthropic", ctxProvider: "custom-anthropic", expected: /Blocked Claude provider/ },
    { name: "meridian", ctxProvider: "meridian", expected: /Blocked Claude provider/ },
    { name: "stale", stale: true, expected: /Unable to verify Claude provider/ },
  ];

  for (const scenario of scenarios) {
    const notifications: string[] = [];
    const ctx = scenario.stale
      ? staleContext((message) => notifications.push(message))
      : {
        model: { provider: scenario.ctxProvider },
        ui: { notify(message: string) { notifications.push(message); } },
      };
    let authCalls = 0;
    let credentialCalls = 0;
    let networkCalls = 0;

    const inputResult = input({ text: "hello", images: [], source: "interactive" }, ctx);
    if (inputResult?.action !== "handled") {
      authCalls++;
      await swallowedBeforeProviderRequest(beforeProviderRequest, payload, ctx);
      credentialCalls++;
      networkCalls++;
    }

    assert.deepEqual(inputResult, { action: "handled" }, scenario.name);
    assert.equal(authCalls, 0, `${scenario.name}: auth should not be called`);
    assert.equal(credentialCalls, 0, `${scenario.name}: credentials should not be called`);
    assert.equal(networkCalls, 0, `${scenario.name}: network should not be called`);
    assert.match(notifications[0], scenario.expected, scenario.name);
    assertNoSecretLeak(notifications[0]);
  }
});

test("registers claude-subscription provider models on the isolated native API", () => {
  const { providers } = loadExtension();
  const provider = providers.get(PROVIDER_ID) as any;

  assert.equal(provider.name, "Claude subscription (Claude Code OAuth)");
  assert.equal(provider.api, SUBSCRIPTION_NATIVE_API_ID);
  assert.notEqual(provider.api, SHARED_ANTHROPIC_API_ID);
  assert.equal(provider.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(
    provider.models.map((model: { id: string }) => model.id),
    [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-7-300k",
      "claude-opus-4-8",
    ],
  );
  assert.deepEqual(
    provider.models.map((model: { id: string; api?: string }) => ({
      id: model.id,
      api: model.api ?? provider.api,
    })),
    [
      { id: "claude-haiku-4-5", api: SUBSCRIPTION_NATIVE_API_ID },
      { id: "claude-sonnet-4-6", api: SUBSCRIPTION_NATIVE_API_ID },
      { id: "claude-opus-4-6", api: SUBSCRIPTION_NATIVE_API_ID },
      { id: "claude-opus-4-7", api: SUBSCRIPTION_NATIVE_API_ID },
      { id: "claude-opus-4-7-300k", api: SUBSCRIPTION_NATIVE_API_ID },
      { id: "claude-opus-4-8", api: SUBSCRIPTION_NATIVE_API_ID },
    ],
  );
  const budgetThinkingLevelMap = { xhigh: "xhigh" };
  const claude46ThinkingLevelMap = { xhigh: "max" };
  const adaptiveOpusThinkingLevelMap = { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" };
  assert.deepEqual(
    provider.models.map((model: { id: string; contextWindow: number; maxTokens: number; reasoning: boolean; thinkingLevelMap: Record<string, string | null>; compat?: { forceAdaptiveThinking?: boolean; nativeModelId?: string; messageBatchesOutputBeta?: string; messageBatchesOutputMaxTokens?: number }; input: string[] }) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      input: model.input,
    })),
    [
      { id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 64000, reasoning: true, thinkingLevelMap: budgetThinkingLevelMap, compat: undefined, input: ["text", "image"] },
      { id: "claude-sonnet-4-6", contextWindow: 200000, maxTokens: 64000, reasoning: true, thinkingLevelMap: claude46ThinkingLevelMap, compat: MESSAGE_BATCHES_OUTPUT_300K_COMPAT, input: ["text", "image"] },
      { id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevelMap: claude46ThinkingLevelMap, compat: MESSAGE_BATCHES_OUTPUT_300K_COMPAT, input: ["text", "image"] },
      { id: "claude-opus-4-7", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevelMap: adaptiveOpusThinkingLevelMap, compat: { forceAdaptiveThinking: true, ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }, input: ["text", "image"] },
      { id: "claude-opus-4-7-300k", contextWindow: 300000, maxTokens: 128000, reasoning: true, thinkingLevelMap: adaptiveOpusThinkingLevelMap, compat: { forceAdaptiveThinking: true, nativeModelId: "claude-opus-4-7", ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }, input: ["text", "image"] },
      { id: "claude-opus-4-8", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevelMap: adaptiveOpusThinkingLevelMap, compat: { forceAdaptiveThinking: true, ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }, input: ["text", "image"] },
    ],
  );

  const modelsById = new Map(provider.models.map((model: any) => [model.id, model]));
  assert.deepEqual(getSupportedThinkingLevels(modelsById.get("claude-sonnet-4-6") as any), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(modelsById.get("claude-opus-4-6") as any), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(modelsById.get("claude-opus-4-7") as any), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(modelsById.get("claude-opus-4-7-300k") as any), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(modelsById.get("claude-opus-4-8") as any), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(clampThinkingLevel(modelsById.get("claude-opus-4-7") as any, "minimal"), "minimal");
  assert.equal(clampThinkingLevel(modelsById.get("claude-opus-4-7-300k") as any, "minimal"), "minimal");
  assert.equal(clampThinkingLevel(modelsById.get("claude-opus-4-8") as any, "minimal"), "minimal");
});

test("registered Opus 4.6 selection sends Opus 4.6 to native Anthropic payload", async () => {
  const { providers } = loadExtension();
  const provider = providers.get(PROVIDER_ID) as any;
  const registeredModel = provider.models.find((candidate: { id: string }) => candidate.id === "claude-opus-4-6");
  assert.ok(registeredModel, "extension must register Opus 4.6");

  const credentialDir = mkdtempSync(join(tmpdir(), "pi-claude-opus46-"));
  writeFileSync(join(credentialDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: FAKE_OAUTH_TOKEN },
  }));

  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  let capturedFetch: { url: string; init?: RequestInit } | undefined;

  try {
    process.env.CLAUDE_CONFIG_DIR = credentialDir;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedFetch = { url: String(input), init };
      return new Response([
        "event: message_start",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_opus46\",\"model\":\"claude-opus-4-6\",\"content\":[]}}",
        "",
        "event: content_block_start",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
        "",
        "event: content_block_delta",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}",
        "",
        "event: content_block_stop",
        "data: {\"type\":\"content_block_stop\",\"index\":0}",
        "",
        "event: message_delta",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}",
        "",
        "event: message_stop",
        "data: {\"type\":\"message_stop\"}",
        "",
      ].join("\n"), { status: 200, headers: { "request-id": "req_opus46" } });
    }) as typeof fetch;

    const selectedModel = { ...registeredModel, provider: PROVIDER_ID, baseUrl: provider.baseUrl };
    const events = await collectStreamEvents(provider.streamSimple(selectedModel, {
      systemPrompt: "Pi system prompt",
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }));

    assert.ok(capturedFetch, "selected Opus 4.6 should make one native Anthropic request");
    assert.equal(capturedFetch.url, "https://api.anthropic.com/v1/messages");
    const headers = capturedFetch.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${FAKE_OAUTH_TOKEN}`);
    assert.equal(headers["x-api-key"], undefined);
    assert.equal(headers["anthropic-api-key"], undefined);

    const body = JSON.parse(String(capturedFetch.init?.body));
    assert.equal(body.model, "claude-opus-4-6");
    assert.notEqual(body.model, "claude-sonnet-4-6");
    assert.notEqual(body.model, "claude-opus-4-7");
    assert.equal(body.max_tokens, 128000);

    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done.message.model, "claude-opus-4-6");
    assert.equal(done.message.responseModel, "claude-opus-4-6");
  } finally {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    globalThis.fetch = originalFetch;
    rmSync(credentialDir, { recursive: true, force: true });
  }
});

test("modelConstantsMatchStablePublicInterface", () => {
  assert.equal(EXPORTED_PROVIDER_ID, PROVIDER_ID);
  assert.equal(EXPORTED_NATIVE_API_ID, SUBSCRIPTION_NATIVE_API_ID);
  assert.deepEqual(
    MODELS.map((model) => model.id),
    ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-7-300k", "claude-opus-4-8"],
  );

  for (const model of MODELS) {
    assert.equal(model.api, SUBSCRIPTION_NATIVE_API_ID, `${model.id} must use isolated native API`);
    assert.notEqual(model.api, SHARED_ANTHROPIC_API_ID, `${model.id} must not use shared Anthropic API`);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
});

test("loading extension does not replace the shared anthropic-messages API provider", (t) => {
  resetApiProviders();
  t.after(() => resetApiProviders());

  const before = getApiProvider(SHARED_ANTHROPIC_API_ID);
  assert.ok(before, "built-in anthropic-messages API provider should be registered before extension load");

  loadExtensionWithApiRegistryBinding();

  assert.equal(getApiProvider(SHARED_ANTHROPIC_API_ID), before);
  assert.ok(getApiProvider(SUBSCRIPTION_NATIVE_API_ID), "subscription native API provider should be registered separately");
});

test("registers native streamSimple with non-proxy provider metadata", () => {
  const { providers } = loadExtension();
  const provider = providers.get(PROVIDER_ID) as any;

  assert.equal(provider.api, SUBSCRIPTION_NATIVE_API_ID);
  assert.equal(provider.baseUrl, "https://api.anthropic.com");
  assert.ok(!provider.baseUrl.includes("4050"));
  assert.ok(!provider.apiKey.includes("ccproxy"));
  assert.equal(typeof provider.streamSimple, "function");
});

test("usageCommandReportsRedactedLocalTokenTelemetry", async () => {
  resetNativeUsageTelemetry();
  recordNativeUsage({
    timestamp: 123,
    model: "claude-sonnet-4-6",
    usage: { input: 100, output: 7, cacheRead: 80, cacheWrite: 20, totalTokens: 207 },
  });

  const commands = loadExtensionWithCommands();
  const usageCommand = commands.get("claude-subscription-usage");
  assert.ok(usageCommand, "usage command must be registered");
  assert.ok(usageCommand.description.length > 0, "usage command must have a description");

  const notifications: Array<{ message: string; level?: string }> = [];
  await usageCommand.handler([], {
    ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /requests=1/);
  assert.match(notifications[0].message, /cacheRead=80/);
  assert.ok(!notifications[0].message.includes(FAKE_OAUTH_TOKEN));
  assert.ok(!notifications[0].message.includes("Authorization"));
});

test("cacheDiagnosticsCommandReportsRedactedCacheReadDrops", async () => {
  resetNativeCacheDiagnostics();
  const firstPayload = anthropicPayload([{ type: "text", text: `secret prompt ${FAKE_OAUTH_TOKEN}` }]);
  const secondPayload = {
    ...firstPayload,
    tools: [{ name: "bash", description: "secret tool details", input_schema: { type: "object" } }],
  };
  recordNativeCacheDiagnosticSample({
    timestamp: 1,
    model: "claude-sonnet-4-6",
    fingerprint: fingerprintNativeRequestShape(firstPayload),
    usage: { input: 20, output: 2, cacheRead: 200, cacheWrite: 10, totalTokens: 232 },
  });
  recordNativeCacheDiagnosticSample({
    timestamp: 2,
    model: "claude-sonnet-4-6",
    fingerprint: fingerprintNativeRequestShape(secondPayload),
    usage: { input: 210, output: 2, cacheRead: 5, cacheWrite: 180, totalTokens: 397 },
  });

  const commands = loadExtensionWithCommands();
  const diagnosticsCommand = commands.get("claude-subscription-cache-diagnostics");
  assert.ok(diagnosticsCommand, "cache diagnostics command must be registered");
  assert.ok(diagnosticsCommand.description.length > 0, "cache diagnostics command must have a description");

  const notifications: Array<{ message: string; level?: string }> = [];
  await diagnosticsCommand.handler([], {
    ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /events=1/);
  assert.match(notifications[0].message, /cache-read-drop/);
  assert.match(notifications[0].message, /changedSections=.*tools/);
  assert.ok(!notifications[0].message.includes(FAKE_OAUTH_TOKEN));
  assert.ok(!notifications[0].message.includes("secret prompt"));
  assert.ok(!notifications[0].message.includes("secret tool details"));
});

test("statusCommandReportsOAuthSubscriptionProviderSettings", async () => {
  const commands = loadExtensionWithCommands();
  const statusCommand = commands.get("claude-subscription-status");
  assert.ok(statusCommand, "status command must be registered");
  assert.ok(statusCommand.description.length > 0, "status command must have a description");

  const notifications: Array<{ message: string; level?: string }> = [];
  await statusCommand.handler([], {
    ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /claude-subscription/);
  assert.match(notifications[0].message, /OAuth/i);
  assert.ok(!/api\s*-?\s*key/i.test(notifications[0].message), "status must not imply API-key billing");
});

test("shapes Claude Code identity as separate first system block", () => {
  const { beforeProviderRequest } = loadExtension();

  const shaped = beforeProviderRequest(
    { payload: anthropicPayload("Pi system prompt") },
    { model: { provider: "claude-subscription" } },
  ) as any;

  assert.deepEqual(shaped.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    { type: "text", text: "Pi system prompt" },
  ]);
});

test("does not duplicate Claude Code identity when already present", () => {
  const { beforeProviderRequest } = loadExtension();

  const shaped = beforeProviderRequest(
    { payload: anthropicPayload(`${CLAUDE_CODE_IDENTITY}\n\nPi system prompt`) },
    { model: { provider: "claude-subscription" } },
  ) as any;

  assert.equal(
    shaped.system.filter((block: { text: string }) => block.text === CLAUDE_CODE_IDENTITY).length,
    1,
  );
  assert.equal(shaped.system[1].text, "Pi system prompt");
});

test("preserves cache control on shaped system blocks", () => {
  const { beforeProviderRequest } = loadExtension();
  const cacheControl = { type: "ephemeral" };

  const shaped = beforeProviderRequest(
    {
      payload: anthropicPayload([
        { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: cacheControl },
        { type: "text", text: "Pi system prompt", cache_control: cacheControl },
      ]),
    },
    { model: { provider: "claude-subscription" } },
  ) as any;

  assert.deepEqual(shaped.system[0].cache_control, cacheControl);
  assert.deepEqual(shaped.system[1].cache_control, cacheControl);
});

test("leaves non-Claude providers unchanged", () => {
  const { beforeProviderRequest } = loadExtension();
  const payload = anthropicPayload("Pi system prompt");

  const result = beforeProviderRequest(
    { payload },
    { model: { provider: "openai-codex" } },
  );

  assert.equal(result, undefined);
});

test("claudeSubscriptionProviderLeavesNonAnthropicPayloadsUnchanged", async () => {
  const { beforeProviderRequest } = loadExtension();
  const payload = { prompt: "hello world", model: "claude-sonnet-4-6" };

  const result = beforeProviderRequest(
    { payload },
    { model: { provider: "claude-subscription" } },
  );

  assert.equal(result, undefined);
  assert.deepEqual(payload, { prompt: "hello world", model: "claude-sonnet-4-6" });

  const finalPayload = await swallowedBeforeProviderRequest(
    beforeProviderRequest,
    payload,
    { model: { provider: "claude-subscription" } },
  );
  assert.equal(finalPayload, payload);
});
