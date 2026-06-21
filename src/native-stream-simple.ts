import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";

import {
  type AnthropicSseEvent,
  parseAnthropicSse,
  type ParseAnthropicSseOptions,
} from "./anthropic-sse.ts";
import { loadClaudeCodeCredentials, type LoadCredentialOptions } from "./credentials.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./models.ts";
import {
  contextToPayload,
  isServerSideFallbackRejectionError,
  markServerSideFallbackUnsupported,
  nativeCompat,
} from "./native-payload.ts";
import {
  buildNativeMessagesRequest,
  type NativeMessagesRequest,
  type NativeMessagesRequestInput,
} from "./native-request.ts";
import {
  streamNativeMessagesSseEvents,
  type NativeStreamRequestOptions,
} from "./native-stream-transport.ts";
import { normalizeEditToolArguments } from "./edit-tool-arguments.ts";
import { redactSensitiveText } from "./redaction.ts";
import {
  parseFinalToolArgumentsFromJson,
  parseToolArgumentsFromJson,
} from "./tool-json-arguments.ts";
import { isRecord } from "./type-guards.ts";

export type NativeStreamRequestResult = string | AsyncIterable<AnthropicSseEvent>;

type NativeCredentialLoadOptions = Pick<LoadCredentialOptions, "forceRefresh" | "previousAccessToken">;

export type NativeStreamSimpleDependencies = {
  loadCredentials?: (options?: NativeCredentialLoadOptions) => Promise<string>;
  buildRequest?: (input: NativeMessagesRequestInput) => NativeMessagesRequest;
  streamRequest?: (
    request: NativeMessagesRequest,
    options?: NativeStreamRequestOptions,
  ) => Promise<NativeStreamRequestResult>;
  parseSse?: (sse: string, options?: ParseAnthropicSseOptions) => AnthropicSseEvent[];
  now?: () => number;
};

type ToolJsonDiagnosticState = {
  partialJson: string;
  deltaChunkCount: number;
  toolName: string;
  startInputKeyCount: number;
  lastParsedJsonLength: number;
};

type ToolJsonState = Map<number, ToolJsonDiagnosticState>;
type NativeStreamContractState = {
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  /** Anthropic indexes of server-side fallback marker blocks (audit-only, never Pi content). */
  fallbackBlockIndexes: Set<number>;
  /** Raw Anthropic stop_reason, kept for refusal-aware error reporting. */
  rawStopReason?: string;
  /** Informational refusal policy category from stop_details (may be absent even on refusal). */
  refusalCategory?: string;
};

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function optionalNumberField(record: unknown, names: readonly string[]): number | undefined {
  if (!isRecord(record)) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function mapStopReason(stopReason: string | undefined): StopReason {
  switch (stopReason) {
    case undefined:
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

function doneReason(stopReason: StopReason): "stop" | "length" | "toolUse" {
  if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") {
    return stopReason;
  }
  return "stop";
}

function shouldApplyCumulativeUsageValue(next: number | undefined, current: number): next is number {
  if (next === undefined) return false;
  return !(next === 0 && current > 0);
}

function updateUsage(model: Model<Api>, output: AssistantMessage, usage: unknown): void {
  const input = optionalNumberField(usage, ["input_tokens"]);
  const outputTokens = optionalNumberField(usage, ["output_tokens"]);
  const cacheRead = optionalNumberField(usage, ["cache_read_input_tokens", "cache_read_tokens"]);
  const cacheWrite = optionalNumberField(usage, ["cache_creation_input_tokens", "cache_creation_tokens"]);

  if (shouldApplyCumulativeUsageValue(input, output.usage.input)) output.usage.input = input;
  if (shouldApplyCumulativeUsageValue(outputTokens, output.usage.output)) output.usage.output = outputTokens;
  if (shouldApplyCumulativeUsageValue(cacheRead, output.usage.cacheRead)) output.usage.cacheRead = cacheRead;
  if (shouldApplyCumulativeUsageValue(cacheWrite, output.usage.cacheWrite)) output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens = output.usage.input
    + output.usage.output
    + output.usage.cacheRead
    + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function setToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  block.arguments = parseToolArgumentsFromJson(partialJson);
}

// Incremental partial-argument parsing re-parses the full accumulated fragment,
// so parsing on every input_json_delta is quadratic in the final input size.
// Measured on this repair pipeline at 128-byte deltas: ~74 ms total CPU for a
// 16 KiB tool input, ~24 s for 270 KiB, ~5 min for 1 MiB — all spent blocking
// the event loop mid-stream. Below the exact-parse bound every delta still
// updates partial arguments (small inputs keep per-delta UI fidelity and the
// historical behavior); above it, re-parse only when the fragment has grown by
// the growth factor since the last parse. The geometric schedule bounds total
// incremental parse work to a constant multiple of the final fragment size.
// Final arguments at content_block_stop are always parsed exactly.
const INCREMENTAL_TOOL_JSON_EXACT_PARSE_BOUND = 16_384;
const INCREMENTAL_TOOL_JSON_REPARSE_GROWTH = 1.25;

function shouldParsePartialToolJson(state: ToolJsonDiagnosticState): boolean {
  if (state.partialJson.length <= INCREMENTAL_TOOL_JSON_EXACT_PARSE_BOUND) return true;
  return state.partialJson.length >= state.lastParsedJsonLength * INCREMENTAL_TOOL_JSON_REPARSE_GROWTH;
}

// Apply the conservative, tool-specific argument normalizer. Only Pi's built-in
// `edit` tool is reshaped (stringified `edits` array + stray annotation keys on
// edit items); every other tool's arguments pass through verbatim.
function normalizeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return name === "edit" ? normalizeEditToolArguments(args) : args;
}

function setFinalToolArgumentsFromJson(block: ToolCall, partialJson: string): void {
  if (partialJson.length === 0) return;
  block.arguments = normalizeToolArguments(block.name, parseFinalToolArgumentsFromJson(partialJson));
}

function assertMessageInProgress(state: NativeStreamContractState): void {
  if (!state.sawMessageStart) {
    throw new Error("Anthropic stream contract violation: missing message_start.");
  }
  if (state.sawMessageStop) {
    throw new Error("Anthropic stream contract violation: content event after message_stop.");
  }
}

function applyAnthropicEvent(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  output: AssistantMessage,
  event: AnthropicSseEvent,
  contentIndexByAnthropicIndex: Map<number, number>,
  toolJsonByContentIndex: ToolJsonState,
  contractState: NativeStreamContractState,
): void {
  if (event.type === "messageStart") {
    if (contractState.sawMessageStart && !contractState.sawMessageStop) {
      throw new Error("Anthropic stream contract violation: duplicate message_start before message_stop.");
    }
    contractState.sawMessageStart = true;
    contractState.sawMessageStop = false;
    if (event.responseId) output.responseId = event.responseId;
    if (event.model) output.responseModel = event.model;
    // Capture input/cache usage from message_start; it is refined by message_delta later.
    if ("usage" in event) updateUsage(model, output, event.usage);
    return;
  }

  if (event.type === "textStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({ type: "text", text: event.text }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "text_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "textDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: text delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "text") throw new Error("Anthropic stream contract violation: text delta for non-text block.");
    block.text += event.text;
    stream.push({ type: "text_delta", contentIndex, delta: event.text, partial: output });
    return;
  }

  if (event.type === "thinkingStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({
      type: "thinking",
      thinking: event.thinking,
      thinkingSignature: "",
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "redactedThinkingStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    const contentIndex = output.content.push({
      type: "thinking",
      thinking: "",
      thinkingSignature: event.data,
      redacted: true,
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "thinkingDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: thinking delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "thinking") throw new Error("Anthropic stream contract violation: thinking delta for non-thinking block.");
    block.thinking += event.thinking;
    stream.push({ type: "thinking_delta", contentIndex, delta: event.thinking, partial: output });
    return;
  }

  if (event.type === "signatureDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: signature delta without content block start.");
    const block = output.content[contentIndex] as ThinkingContent | undefined;
    if (block?.type !== "thinking") throw new Error("Anthropic stream contract violation: signature delta for non-thinking block.");
    block.thinkingSignature = (block.thinkingSignature ?? "") + event.signature;
    return;
  }

  if (event.type === "fallbackStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index) || contractState.fallbackBlockIndexes.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    contractState.fallbackBlockIndexes.add(event.index);

    // The marker is audit-only and never becomes Pi content, but it is also the
    // replay boundary: blocks the refused model emitted BEFORE it must be
    // omitted when this assistant turn is echoed back (thinking,
    // redacted_thinking, and tool_use pre-boundary blocks are rejected or
    // ignored by the API; text echoes normally). Clearing the signature makes
    // convertAssistantMessage skip the thinking block on replay; dropping
    // closed pre-boundary tool calls keeps Pi from executing calls the serving
    // model never made. Tool calls are only dropped when no content block is
    // open, so live contentIndex mappings never shift.
    for (const block of output.content) {
      if (block.type === "thinking") block.thinkingSignature = "";
    }
    if (contentIndexByAnthropicIndex.size === 0) {
      output.content = output.content.filter((block) => block.type !== "toolCall");
    }
    return;
  }

  if (event.type === "toolUseStart") {
    assertMessageInProgress(contractState);
    if (contentIndexByAnthropicIndex.has(event.index)) {
      throw new Error("Anthropic stream contract violation: duplicate content block start.");
    }
    if (event.id.trim().length === 0 || event.name.trim().length === 0) {
      throw new Error("Anthropic stream contract violation: tool_use requires non-empty id and name.");
    }
    if (!isRecord(event.input)) {
      throw new Error("Anthropic stream contract violation: tool_use input must be an object.");
    }

    const contentIndex = output.content.push({
      type: "toolCall",
      id: event.id,
      name: event.name,
      // Normalize inline (non-streamed) tool input here too: when Anthropic
      // sends the full input on tool_use start with no input_json_delta, the
      // empty-payload final-stop path leaves these arguments as the executed set.
      arguments: normalizeToolArguments(event.name, { ...event.input }),
    }) - 1;
    contentIndexByAnthropicIndex.set(event.index, contentIndex);
    toolJsonByContentIndex.set(contentIndex, {
      partialJson: "",
      deltaChunkCount: 0,
      toolName: event.name,
      startInputKeyCount: Object.keys(event.input).length,
      lastParsedJsonLength: 0,
    });
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    return;
  }

  if (event.type === "toolUseInputDelta") {
    assertMessageInProgress(contractState);
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: tool input delta without content block start.");
    const block = output.content[contentIndex];
    if (block?.type !== "toolCall") throw new Error("Anthropic stream contract violation: tool input delta for non-tool block.");
    const state = toolJsonByContentIndex.get(contentIndex) ?? {
      partialJson: "",
      deltaChunkCount: 0,
      toolName: block.name,
      startInputKeyCount: 0,
      lastParsedJsonLength: 0,
    };
    state.partialJson += event.partialJson;
    state.deltaChunkCount += 1;
    toolJsonByContentIndex.set(contentIndex, state);
    if (shouldParsePartialToolJson(state)) {
      state.lastParsedJsonLength = state.partialJson.length;
      setToolArgumentsFromJson(block, state.partialJson);
    }
    stream.push({ type: "toolcall_delta", contentIndex, delta: event.partialJson, partial: output });
    return;
  }

  if (event.type === "contentBlockStop") {
    assertMessageInProgress(contractState);
    if (contractState.fallbackBlockIndexes.has(event.index)) {
      contractState.fallbackBlockIndexes.delete(event.index);
      return;
    }
    const contentIndex = contentIndexByAnthropicIndex.get(event.index);
    if (contentIndex === undefined) throw new Error("Anthropic stream contract violation: content block stop without content block start.");
    const block = output.content[contentIndex];
    contentIndexByAnthropicIndex.delete(event.index);

    if (block?.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block?.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
    } else if (block?.type === "toolCall") {
      const state = toolJsonByContentIndex.get(contentIndex) ?? {
        partialJson: "",
        deltaChunkCount: 0,
        toolName: block.name,
        startInputKeyCount: Object.keys(block.arguments).length,
        lastParsedJsonLength: 0,
      };
      try {
        setFinalToolArgumentsFromJson(block, state.partialJson);
      } catch (error) {
        toolJsonByContentIndex.delete(contentIndex);
        throw error;
      }
      toolJsonByContentIndex.delete(contentIndex);
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    } else {
      throw new Error("Anthropic stream contract violation: content block stop for unknown block.");
    }
    return;
  }

  if (event.type === "messageDelta") {
    if (!contractState.sawMessageStart) {
      throw new Error("Anthropic stream contract violation: missing message_start.");
    }
    if (event.stopReason) contractState.rawStopReason = event.stopReason;
    if (event.stopDetailsCategory) contractState.refusalCategory = event.stopDetailsCategory;
    output.stopReason = mapStopReason(event.stopReason);
    if ("usage" in event) updateUsage(model, output, event.usage);
    return;
  }

  if (event.type === "messageStop") {
    if (!contractState.sawMessageStart) {
      throw new Error("Anthropic stream contract violation: missing message_start.");
    }
    if (contentIndexByAnthropicIndex.size > 0) {
      throw new Error("Anthropic stream contract violation: missing content block stop before message_stop.");
    }
    contractState.sawMessageStop = true;
    if (event.stopReason) contractState.rawStopReason = event.stopReason;
    output.stopReason = mapStopReason(event.stopReason) === "stop" && output.stopReason !== "stop"
      ? output.stopReason
      : mapStopReason(event.stopReason);
    return;
  }

  if (event.type === "contractViolation") {
    throw new Error(event.message);
  }
}

function safeStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function diagnosticToken(value: string, maxLength = 96): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:@/-]+/g, "_");
  const token = /[A-Za-z0-9]/.test(sanitized) ? sanitized : "unknown";
  return token.length > maxLength ? `${token.slice(0, maxLength)}…` : token;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const matched = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return matched?.[1];
}

function anthropicErrorTypeFromMessage(message: string): string | undefined {
  const match = /"error"\s*:\s*\{[^{}]*"type"\s*:\s*"([^"]+)"/.exec(message);
  return match?.[1] ? diagnosticToken(match[1]) : undefined;
}

const RESPONSE_DIAGNOSTIC_HEADER_PATTERNS = [
  /^anthropic-ratelimit-/i,
  /^retry-after$/i,
  /^content-type$/i,
] as const;

function responseHeaderDiagnosticParts(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => RESPONSE_DIAGNOSTIC_HEADER_PATTERNS.some((pattern) => pattern.test(name)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `response_${diagnosticToken(name.toLowerCase(), 120)}=${diagnosticToken(value, 160)}`);
}

function activeToolDiagnosticParts(toolJsonByContentIndex: ToolJsonState): string[] {
  const activeTools = [...toolJsonByContentIndex.entries()];
  if (activeTools.length === 0) return [];

  if (activeTools.length === 1) {
    const [, state] = activeTools[0];
    return [
      `open_tool=${state.toolName}`,
      `tool_json_bytes=${Buffer.byteLength(state.partialJson, "utf8")}`,
      `tool_json_deltas=${state.deltaChunkCount}`,
      `tool_start_keys=${state.startInputKeyCount}`,
    ];
  }

  const totalBytes = activeTools.reduce(
    (sum, [, state]) => sum + Buffer.byteLength(state.partialJson, "utf8"),
    0,
  );
  const totalDeltas = activeTools.reduce((sum, [, state]) => sum + state.deltaChunkCount, 0);
  return [
    `open_tools=${activeTools.length}`,
    `tool_json_bytes=${totalBytes}`,
    `tool_json_deltas=${totalDeltas}`,
  ];
}

function errorCauseMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const cause = error.cause;
  if (cause === undefined) return undefined;

  if (cause instanceof Error) {
    const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
    return [code, cause.message].filter(Boolean).join(": ");
  }

  if (isRecord(cause)) {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const message = typeof cause.message === "string" ? cause.message : undefined;
    const text = [code, message].filter(Boolean).join(": ");
    return text.length > 0 ? text : undefined;
  }

  return String(cause);
}

function errorMessageFrom(error: unknown, knownSecrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = errorCauseMessage(error);
  return redactSensitiveText(
    causeMessage && !message.includes(causeMessage) ? `${message}; cause: ${causeMessage}` : message,
    knownSecrets,
  );
}

function accessTokenSecrets(accessToken: string): string[] {
  return [accessToken, `Bearer ${accessToken}`];
}

function appendUniqueSecrets(secrets: readonly string[], additions: readonly string[]): string[] {
  const next = [...secrets];
  for (const addition of additions) {
    if (!next.includes(addition)) next.push(addition);
  }
  return next;
}

function isRefreshableAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bauthentication_error\b/i.test(message)) return true;

  if (isRecord(error)) {
    if (error.status === 401) return true;
    if (typeof error.type === "string" && /\bauthentication_error\b/i.test(error.type)) return true;
  }

  return /(?:^|\D)401(?:\D|$)/.test(message);
}

function assertClaudeSubscriptionProvider(model: Model<Api>): void {
  if (model.provider === CLAUDE_SUBSCRIPTION_PROVIDER_ID) return;

  throw new Error(
    `Native Claude subscription stream refused provider '${model.provider}'. `
      + `Use provider '${CLAUDE_SUBSCRIPTION_PROVIDER_ID}'.`,
  );
}

export function createNativeStreamSimple(
  dependencies: NativeStreamSimpleDependencies = {},
) {
  const loadCredentials = dependencies.loadCredentials
    ?? ((options?: NativeCredentialLoadOptions) => loadClaudeCodeCredentials(undefined, options));
  const buildRequest = dependencies.buildRequest ?? buildNativeMessagesRequest;
  const streamRequest = dependencies.streamRequest ?? streamNativeMessagesSseEvents;
  const parseSse = dependencies.parseSse ?? parseAnthropicSse;
  const now = dependencies.now ?? Date.now;

  return (
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions = {},
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: now(),
      };
      let knownSecrets: string[] = [];
      const contractState: NativeStreamContractState = {
        sawMessageStart: false,
        sawMessageStop: false,
        fallbackBlockIndexes: new Set(),
      };
      const diagnostics: {
        responseStatus?: number;
        anthropicRequestId?: string;
        lastEventType?: string;
        sawToolBlock: boolean;
        responseHeaderParts?: string[];
      } = { sawToolBlock: false };
      let requestForDiagnostics: NativeMessagesRequest | undefined;
      const contentIndexByAnthropicIndex = new Map<number, number>();
      const toolJsonByContentIndex: ToolJsonState = new Map();

      try {
        stream.push({ type: "start", partial: output });
        assertClaudeSubscriptionProvider(model);

        // Credential loading is file/Keychain I/O (or an OAuth refresh round
        // trip) and does not depend on the converted payload, so it runs
        // concurrently with the CPU-bound Pi -> Anthropic conversion below.
        // The no-op catch prevents an unhandled rejection when conversion
        // throws first; the await after conversion still surfaces the
        // original credential error to the stream.
        const accessTokenPromise = loadCredentials();
        accessTokenPromise.catch(() => {});
        const rawPayload = contextToPayload(model, context, options);
        const payloadResult = options.onPayload
          ? ((await options.onPayload(rawPayload, model)) ?? rawPayload)
          : rawPayload;
        const payload = payloadResult as Record<string, unknown>;
        const requestInput = {
          payload,
          cacheRetention: options.cacheRetention,
          supportsLongCacheRetention: nativeCompat(model)?.supportsLongCacheRetention ?? true,
        };
        const buildRequestFor = (requestAccessToken: string): NativeMessagesRequest => buildRequest({
          accessToken: requestAccessToken,
          ...requestInput,
        });
        let accessToken = await accessTokenPromise;
        knownSecrets = accessTokenSecrets(accessToken);
        let request = buildRequestFor(accessToken);
        requestForDiagnostics = request;
        const streamRequestOptions = (): NativeStreamRequestOptions => ({
          signal: options.signal,
          knownSecrets,
          timeoutMs: options.timeoutMs,
          streamNoProgressTimeoutMs: (options as { streamNoProgressTimeoutMs?: number }).streamNoProgressTimeoutMs,
          onResponse: async (response) => {
            diagnostics.responseStatus = response.status;
            const requestId = response.headers["request-id"] ?? response.headers["anthropic-request-id"];
            if (typeof requestId === "string" && requestId.length > 0) {
              diagnostics.anthropicRequestId = requestId;
            }
            const responseHeaderParts = responseHeaderDiagnosticParts(response.headers);
            if (responseHeaderParts.length > 0) diagnostics.responseHeaderParts = responseHeaderParts;
            await options.onResponse?.(response, model);
          },
        });
        let eventSource: NativeStreamRequestResult;
        try {
          eventSource = await streamRequest(request, streamRequestOptions());
        } catch (error) {
          if (options.signal?.aborted) throw error;

          if (Array.isArray(payload.fallbacks) && isServerSideFallbackRejectionError(error)) {
            // The lane rejected the `fallbacks` beta (e.g. not enabled for this
            // account). Retry once without it and latch off for the process;
            // refusals then surface as terminal errors instead of falling back.
            markServerSideFallbackUnsupported();
            delete payload.fallbacks;
            request = buildRequestFor(accessToken);
            requestForDiagnostics = request;
            eventSource = await streamRequest(request, streamRequestOptions());
          } else if (isRefreshableAuthenticationError(error)) {
            accessToken = await loadCredentials({ forceRefresh: true, previousAccessToken: accessToken });
            knownSecrets = appendUniqueSecrets(knownSecrets, accessTokenSecrets(accessToken));
            request = buildRequestFor(accessToken);
            requestForDiagnostics = request;
            eventSource = await streamRequest(request, streamRequestOptions());
          } else {
            throw error;
          }
        }
        const events = typeof eventSource === "string"
          ? parseSse(eventSource, { knownSecrets })
          : eventSource;

        for await (const event of events) {
          diagnostics.lastEventType = event.type;
          if (event.type === "toolUseStart") diagnostics.sawToolBlock = true;
          applyAnthropicEvent(
            stream,
            model,
            output,
            event,
            contentIndexByAnthropicIndex,
            toolJsonByContentIndex,
            contractState,
          );
        }

        if (!contractState.sawMessageStart) {
          throw new Error("Anthropic stream contract violation: missing message_start.");
        }
        if (contentIndexByAnthropicIndex.size > 0) {
          throw new Error("Anthropic stream contract violation: missing content block stop before message_stop.");
        }
        if (!contractState.sawMessageStop) {
          throw new Error("Anthropic stream contract violation: missing message_stop.");
        }

        if (options.signal?.aborted) throw new Error("Request was aborted");
        if (output.stopReason === "error") {
          if (contractState.rawStopReason === "refusal") {
            const fallbackModels = Array.isArray(request.body.fallbacks)
              ? request.body.fallbacks
                .map((entry) => (isRecord(entry) ? safeStringField(entry.model) : undefined))
                .filter((entry): entry is string => entry !== undefined)
              : [];
            const category = contractState.refusalCategory ? ` (category: ${contractState.refusalCategory})` : "";
            const fallbackNote = fallbackModels.length
              ? `; the server-side fallback (${fallbackModels.join(", ")}) also declined or was unavailable`
              : "";
            throw new Error(
              `Anthropic safety classifiers declined this request with stop_reason=refusal${category}${fallbackNote}. `
                + "Rephrase the request or switch to an Opus model for this turn.",
            );
          }
          throw new Error(
            `Anthropic stream ended with an unsupported stop reason${contractState.rawStopReason ? ` '${contractState.rawStopReason}'` : ""}`,
          );
        }

        stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
        stream.end();

      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        const baseMessage = errorMessageFrom(error, knownSecrets);
        const endpoint = requestForDiagnostics ? new URL(requestForDiagnostics.url).pathname : undefined;
        const authKind = requestForDiagnostics
          ? (headerValue(requestForDiagnostics.headers, "authorization") ? "oauth_bearer" : "none")
          : undefined;
        const anthropicErrorType = anthropicErrorTypeFromMessage(baseMessage);
        const diagnosticParts = [
          diagnostics.responseStatus !== undefined ? `status=${diagnostics.responseStatus}` : undefined,
          diagnostics.anthropicRequestId ? `request_id=${diagnostics.anthropicRequestId}` : undefined,
          anthropicErrorType ? `anthropic_error_type=${anthropicErrorType}` : undefined,
          diagnostics.lastEventType ? `last_event=${diagnostics.lastEventType}` : undefined,
          `saw_message_stop=${contractState.sawMessageStop}`,
          `saw_tool_block=${diagnostics.sawToolBlock}`,
          `model=${model.id}`,
          output.responseModel ? `response_model=${output.responseModel}` : undefined,
          output.responseId ? `response_id=${output.responseId}` : undefined,
          ...(diagnostics.responseHeaderParts ?? []),
          endpoint ? `endpoint=${diagnosticToken(endpoint)}` : undefined,
          authKind ? `auth=${authKind}` : undefined,
          contentIndexByAnthropicIndex.size > 0 ? `open_content_blocks=${contentIndexByAnthropicIndex.size}` : undefined,
          ...activeToolDiagnosticParts(toolJsonByContentIndex),
          output.usage.output > 0 ? `usage_output=${output.usage.output}` : undefined,
          output.usage.cacheRead > 0 ? `usage_cache_read=${output.usage.cacheRead}` : undefined,
          output.usage.cacheWrite > 0 ? `usage_cache_write=${output.usage.cacheWrite}` : undefined,
        ].filter((part): part is string => part !== undefined);
        output.errorMessage = diagnosticParts.length > 0
          ? `${baseMessage} [${diagnosticParts.join("; ")}]`
          : baseMessage;

        // Drop tool-call blocks from errored assistant messages that never saw a
        // clean message_stop: an incomplete tool_use is not safe to expose as an
        // executable-looking tool call. Aborted messages preserve whatever Pi
        // already streamed so partial output can still be inspected.
        if (output.stopReason === "error" && !contractState.sawMessageStop) {
          output.content = output.content.filter((block) => block.type !== "toolCall");
        }

        stream.push({
          type: "error",
          reason: output.stopReason === "aborted" ? "aborted" : "error",
          error: output,
        });
        stream.end();
      }
    })();

    return stream;
  };
}

export const streamNativeClaudeSubscription = createNativeStreamSimple();
