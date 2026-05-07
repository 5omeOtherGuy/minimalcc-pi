import type { NativeMessagesRequest } from "./native-request.ts";
import { redactSensitiveText } from "./redaction.ts";
import { isRecord } from "./type-guards.ts";

export type NativeFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type NativeFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type NativeFetch = (
  url: string,
  init: NativeFetchInit,
) => Promise<NativeFetchResponse>;

export type NativeTransportOptions = {
  fetch?: NativeFetch;
};

export class NativeTransportError extends Error {
  status: number;
  type?: string;
  requestId?: string;

  constructor(message: string, options: { status: number; type?: string; requestId?: string }) {
    super(message);
    this.name = "NativeTransportError";
    this.status = options.status;
    this.type = options.type;
    this.requestId = options.requestId;
  }
}

function parseJsonMaybe(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorDetails(parsed: unknown, fallbackMessage: string): { type?: string; message: string } {
  if (isRecord(parsed)) {
    const nestedError = parsed.error;
    if (isRecord(nestedError)) {
      return {
        type: typeof nestedError.type === "string" ? nestedError.type : undefined,
        message: typeof nestedError.message === "string" ? nestedError.message : fallbackMessage,
      };
    }

    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      message: typeof parsed.message === "string" ? parsed.message : fallbackMessage,
    };
  }

  return { message: fallbackMessage };
}

function requestIdFrom(response: NativeFetchResponse): string | undefined {
  return response.headers.get("request-id")
    ?? response.headers.get("anthropic-request-id")
    ?? undefined;
}

function nativeFetch(): NativeFetch {
  if (typeof globalThis.fetch !== "function") {
    return async () => {
      throw new NativeTransportError(
        "Anthropic Messages API fetch implementation is unavailable",
        { status: 0 },
      );
    };
  }

  return async (url, init) => globalThis.fetch(url, init);
}

function requestSecrets(headers: Record<string, string>): string[] {
  const authorization = headers.Authorization ?? headers.authorization;
  if (!authorization) return [];

  const secrets = [authorization];
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearerMatch?.[1]) secrets.push(bearerMatch[1]);
  return secrets;
}

function transportErrorMessage(
  type: string | undefined,
  message: string,
  requestId: string | undefined,
  knownSecrets: readonly string[],
): string {
  const sanitizedMessage = redactSensitiveText(message, knownSecrets);
  return [
    "Anthropic Messages API error",
    type ? `${type}: ${sanitizedMessage}` : sanitizedMessage,
    requestId ? `request id: ${requestId}` : undefined,
  ].filter(Boolean).join("; ");
}

export async function postNativeMessagesRequest(
  request: NativeMessagesRequest,
  options: NativeTransportOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetch ?? nativeFetch();
  const knownSecrets = requestSecrets(request.headers);

  let response: NativeFetchResponse;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    if (error instanceof NativeTransportError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new NativeTransportError(
      `Anthropic Messages API transport error: ${redactSensitiveText(message, knownSecrets)}`,
      { status: 0 },
    );
  }

  const responseText = await response.text();
  const parsed = parseJsonMaybe(responseText);

  if (!response.ok) {
    const requestId = requestIdFrom(response);
    const { type, message } = errorDetails(
      parsed,
      responseText || response.statusText || "Request failed",
    );

    throw new NativeTransportError(
      transportErrorMessage(type, message, requestId, knownSecrets),
      { status: response.status, type, requestId },
    );
  }

  return parsed;
}
