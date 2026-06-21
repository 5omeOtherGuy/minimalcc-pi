import type { ProviderResponse } from "@earendil-works/pi-ai";

import {
  type AnthropicSseEvent,
  parseAnthropicSseStream,
} from "./anthropic-sse.ts";
import {
  ANTHROPIC_MESSAGES_URL,
  type NativeMessagesRequest,
} from "./native-request.ts";
import { redactSensitiveText } from "./redaction.ts";
import { isRecord } from "./type-guards.ts";

export type NativeStreamRequestOptions = {
  signal?: AbortSignal;
  knownSecrets?: readonly string[];
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
  timeoutMs?: number;
  streamNoProgressTimeoutMs?: number;
};

// Default upper bound on how long an Anthropic Messages stream body may go
// without progress after response headers arrive before the request is aborted
// with a clear progress error. Anthropic emits SSE `ping` events during normal
// streaming, so 45 s gives multiple pings of headroom while still surfacing a
// stuck connection instead of leaving Pi on "Working...".
export const DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS = 45_000;

// Response-start latency is different from in-stream idleness: Anthropic cannot
// emit SSE ping events until it has sent response headers, and large cached Opus
// requests can legitimately spend longer than the stream-body idle budget before
// the first byte. Keep a bounded watchdog for dead connections, but make the
// implicit response-start budget longer than the post-start no-progress budget.
export const DEFAULT_RESPONSE_START_TIMEOUT_MS = 120_000;

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

function combineStreamAbortSignals(
  signal: AbortSignal | undefined,
  options: NativeStreamRequestOptions,
  behavior: { includeTotalTimeout?: boolean } = {},
): { signal?: AbortSignal; responseStarted: () => void; cleanup: () => void } {
  const totalTimeoutMs = behavior.includeTotalTimeout === false ? undefined : options.timeoutMs;
  const responseStartTimeoutMs = options.streamNoProgressTimeoutMs
    ?? options.timeoutMs
    ?? DEFAULT_RESPONSE_START_TIMEOUT_MS;
  const needsController = signal
    || (typeof totalTimeoutMs === "number" && totalTimeoutMs > 0)
    || (typeof responseStartTimeoutMs === "number" && responseStartTimeoutMs > 0);
  if (!needsController) {
    return { signal: undefined, responseStarted: () => {}, cleanup: () => {} };
  }

  const controller = new AbortController();
  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  let responseStartTimeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromInput = () => controller.abort(signal?.reason);

  if (signal?.aborted) abortFromInput();
  signal?.addEventListener("abort", abortFromInput, { once: true });

  if (typeof totalTimeoutMs === "number" && totalTimeoutMs > 0) {
    totalTimeout = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${totalTimeoutMs}ms`)),
      totalTimeoutMs,
    );
  }
  if (typeof responseStartTimeoutMs === "number" && responseStartTimeoutMs > 0) {
    responseStartTimeout = setTimeout(
      () => controller.abort(new Error(`Anthropic Messages API stream made no progress for ${responseStartTimeoutMs}ms before response started`)),
      responseStartTimeoutMs,
    );
  }

  const clearResponseStartTimeout = () => {
    if (responseStartTimeout) clearTimeout(responseStartTimeout);
    responseStartTimeout = undefined;
  };

  return {
    signal: controller.signal,
    responseStarted: clearResponseStartTimeout,
    cleanup: () => {
      if (totalTimeout) clearTimeout(totalTimeout);
      clearResponseStartTimeout();
      signal?.removeEventListener("abort", abortFromInput);
    },
  };
}

async function fetchNativeMessagesResponse(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions,
  behavior: { includeTotalTimeout?: boolean } = {},
): Promise<{ response: Response; cleanup: () => void }> {
  // Defense-in-depth: refuse to send the OAuth Bearer token anywhere except
  // the canonical Anthropic Messages endpoint. The URL is built from the
  // hardcoded ANTHROPIC_MESSAGES_URL constant in src/native-request.ts; this
  // invariant fails closed if any future change introduces a configurable or
  // caller-supplied URL on this code path.
  if (request.url !== ANTHROPIC_MESSAGES_URL) {
    throw new Error(
      `Anthropic Messages API stream refused outbound URL: only ${ANTHROPIC_MESSAGES_URL} is allowed.`,
    );
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Anthropic Messages API fetch implementation is unavailable");
  }

  const { signal, responseStarted, cleanup } = combineStreamAbortSignals(options.signal, options, behavior);
  const fetchInit: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  };
  try {
    const response = await globalThis.fetch(request.url, fetchInit);
    responseStarted();
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(
      `Anthropic Messages API stream transport error: ${errorMessageFrom(error, options.knownSecrets ?? [])}`,
    );
  }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value: string, key: string) => { headers[key] = value; });
  return headers;
}

function responseErrorMessage(response: Response, responseText: string, knownSecrets: readonly string[]): string {
  const requestId = response.headers.get("request-id") ?? response.headers.get("anthropic-request-id");
  const message = [
    `Anthropic Messages API stream error: ${response.status}`,
    responseText || response.statusText,
    requestId ? `request id: ${requestId}` : undefined,
  ].filter(Boolean).join("; ");
  return redactSensitiveText(message, knownSecrets);
}

async function assertOkResponse(response: Response, options: NativeStreamRequestOptions): Promise<void> {
  if (response.ok) return;
  throw new Error(responseErrorMessage(response, await response.text(), options.knownSecrets ?? []));
}

export async function streamNativeMessagesSse(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions = {},
): Promise<string> {
  const { response, cleanup } = await fetchNativeMessagesResponse(request, options);
  try {
    await options.onResponse?.({ status: response.status, headers: responseHeaders(response) });
    const responseText = await response.text();
    if (!response.ok) throw new Error(responseErrorMessage(response, responseText, options.knownSecrets ?? []));
    return responseText;
  } finally {
    cleanup();
  }
}

type NoProgressWatchdog = {
  readonly timeout: Promise<never>;
  beginRead: () => void;
  endRead: () => void;
  cleanup: () => void;
};

function createNoProgressWatchdog(noProgressTimeoutMs: number | undefined): NoProgressWatchdog | undefined {
  if (!noProgressTimeoutMs || noProgressTimeoutMs <= 0) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let readStartedAt = performance.now();
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const errorMessage = `Anthropic Messages API stream made no progress for ${noProgressTimeoutMs}ms`;

  const arm = (delayMs: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (!reading) return;

      const elapsedMs = performance.now() - readStartedAt;
      const remainingMs = noProgressTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        rejectTimeout(new Error(errorMessage));
        return;
      }
      arm(remainingMs);
    }, delayMs);
  };

  return {
    timeout,
    beginRead: () => {
      reading = true;
      readStartedAt = performance.now();
      if (!timer) arm(noProgressTimeoutMs);
    },
    endRead: () => { reading = false; },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      reading = false;
    },
  };
}

async function* responseBodyTextChunks(
  response: Response,
  noProgressTimeoutMs: number | undefined,
): AsyncGenerator<string> {
  if (!response.body) {
    yield await response.text();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const watchdog = createNoProgressWatchdog(noProgressTimeoutMs);
  try {
    while (true) {
      watchdog?.beginRead();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await (watchdog
          ? Promise.race([reader.read(), watchdog.timeout])
          : reader.read());
      } finally {
        watchdog?.endRead();
      }
      const { value, done } = result;
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    watchdog?.cleanup();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamNativeMessagesSseEvents(
  request: NativeMessagesRequest,
  options: NativeStreamRequestOptions = {},
): Promise<AsyncIterable<AnthropicSseEvent>> {
  // Incremental SSE streams must not keep an absolute post-response timeout:
  // Pi forwards its default 300s HTTP idle timeout as timeoutMs, and long active
  // tool-input streams (large write/edit JSON) can legitimately exceed that
  // while still making progress. The body no-progress watchdog below handles
  // genuinely stalled streams after response headers arrive.
  const { response, cleanup } = await fetchNativeMessagesResponse(request, options, { includeTotalTimeout: false });
  try {
    await options.onResponse?.({ status: response.status, headers: responseHeaders(response) });
    await assertOkResponse(response, options);
  } catch (error) {
    cleanup();
    throw error;
  }

  const noProgressTimeoutMs = options.streamNoProgressTimeoutMs ?? DEFAULT_STREAM_NO_PROGRESS_TIMEOUT_MS;

  async function* events(): AsyncGenerator<AnthropicSseEvent> {
    try {
      yield* parseAnthropicSseStream(responseBodyTextChunks(response, noProgressTimeoutMs), { knownSecrets: options.knownSecrets });
    } finally {
      cleanup();
    }
  }

  return events();
}
