import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
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
import {
  activeToolDiagnosticParts,
  applyAnthropicEvent,
  createNativeStreamEventState,
  type NativeStreamEventState,
} from "./native-stream-events.ts";
import { redactSensitiveText } from "./redaction.ts";
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

function doneReason(stopReason: StopReason): "stop" | "length" | "toolUse" {
  if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") {
    return stopReason;
  }
  return "stop";
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

function formatStreamErrorMessage(
  error: unknown,
  knownSecrets: readonly string[],
  diagnostics: {
    responseStatus?: number;
    anthropicRequestId?: string;
    lastEventType?: string;
    sawToolBlock: boolean;
    responseHeaderParts?: string[];
  },
  eventState: NativeStreamEventState,
  requestForDiagnostics: NativeMessagesRequest | undefined,
  model: Model<Api>,
  output: AssistantMessage,
): string {
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
    `saw_message_stop=${eventState.contractState.sawMessageStop}`,
    `saw_tool_block=${diagnostics.sawToolBlock}`,
    `model=${model.id}`,
    output.responseModel ? `response_model=${output.responseModel}` : undefined,
    output.responseId ? `response_id=${output.responseId}` : undefined,
    ...(diagnostics.responseHeaderParts ?? []),
    endpoint ? `endpoint=${diagnosticToken(endpoint)}` : undefined,
    authKind ? `auth=${authKind}` : undefined,
    eventState.contentIndexByAnthropicIndex.size > 0 ? `open_content_blocks=${eventState.contentIndexByAnthropicIndex.size}` : undefined,
    ...activeToolDiagnosticParts(eventState),
    output.usage.output > 0 ? `usage_output=${output.usage.output}` : undefined,
    output.usage.cacheRead > 0 ? `usage_cache_read=${output.usage.cacheRead}` : undefined,
    output.usage.cacheWrite > 0 ? `usage_cache_write=${output.usage.cacheWrite}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return diagnosticParts.length > 0
    ? `${baseMessage} [${diagnosticParts.join("; ")}]`
    : baseMessage;
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
      const eventState = createNativeStreamEventState();
      const diagnostics: {
        responseStatus?: number;
        anthropicRequestId?: string;
        lastEventType?: string;
        sawToolBlock: boolean;
        responseHeaderParts?: string[];
      } = { sawToolBlock: false };
      let requestForDiagnostics: NativeMessagesRequest | undefined;

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
        const buildRequestForToken = (requestAccessToken: string): NativeMessagesRequest => {
          const nextRequest = buildRequest({
            accessToken: requestAccessToken,
            ...requestInput,
          });
          requestForDiagnostics = nextRequest;
          return nextRequest;
        };
        let accessToken = await accessTokenPromise;
        knownSecrets = accessTokenSecrets(accessToken);
        let request = buildRequestForToken(accessToken);
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
            request = buildRequestForToken(accessToken);
            eventSource = await streamRequest(request, streamRequestOptions());
          } else if (isRefreshableAuthenticationError(error)) {
            accessToken = await loadCredentials({ forceRefresh: true, previousAccessToken: accessToken });
            knownSecrets = appendUniqueSecrets(knownSecrets, accessTokenSecrets(accessToken));
            request = buildRequestForToken(accessToken);
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
            eventState,
          );
        }

        if (!eventState.contractState.sawMessageStart) {
          throw new Error("Anthropic stream contract violation: missing message_start.");
        }
        if (eventState.contentIndexByAnthropicIndex.size > 0) {
          throw new Error("Anthropic stream contract violation: missing content block stop before message_stop.");
        }
        if (!eventState.contractState.sawMessageStop) {
          throw new Error("Anthropic stream contract violation: missing message_stop.");
        }

        if (options.signal?.aborted) throw new Error("Request was aborted");
        if (output.stopReason === "error") {
          if (eventState.contractState.rawStopReason === "refusal") {
            const fallbackModels = Array.isArray(request.body.fallbacks)
              ? request.body.fallbacks
                .map((entry) => (isRecord(entry) ? safeStringField(entry.model) : undefined))
                .filter((entry): entry is string => entry !== undefined)
              : [];
            const category = eventState.contractState.refusalCategory ? ` (category: ${eventState.contractState.refusalCategory})` : "";
            const fallbackNote = fallbackModels.length
              ? `; the server-side fallback (${fallbackModels.join(", ")}) also declined or was unavailable`
              : "";
            throw new Error(
              `Anthropic safety classifiers declined this request with stop_reason=refusal${category}${fallbackNote}. `
                + "Rephrase the request or switch to an Opus model for this turn.",
            );
          }
          throw new Error(
            `Anthropic stream ended with an unsupported stop reason${eventState.contractState.rawStopReason ? ` '${eventState.contractState.rawStopReason}'` : ""}`,
          );
        }

        stream.push({ type: "done", reason: doneReason(output.stopReason), message: output });
        stream.end();

      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatStreamErrorMessage(
          error,
          knownSecrets,
          diagnostics,
          eventState,
          requestForDiagnostics,
          model,
          output,
        );

        // Drop tool-call blocks from errored assistant messages that never saw a
        // clean message_stop: an incomplete tool_use is not safe to expose as an
        // executable-looking tool call. Aborted messages preserve whatever Pi
        // already streamed so partial output can still be inspected.
        if (output.stopReason === "error" && !eventState.contractState.sawMessageStop) {
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
