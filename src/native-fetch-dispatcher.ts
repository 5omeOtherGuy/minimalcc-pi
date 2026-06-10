import { EnvHttpProxyAgent } from "undici";

import { isRecord } from "./type-guards.ts";

// Connection keep-alive for native Anthropic Messages requests.
//
// undici's default keepAliveTimeout is 4 s and api.anthropic.com sends no
// Keep-Alive response hint, so the pooled TLS connection is closed client-side
// after any 4 s gap between requests. Agent turns are routinely further apart
// than that (tool runs, user typing), which makes most requests pay a fresh
// DNS + TCP + TLS handshake before the first byte. Measured live on 2026-06-10:
// a request after a >= 6 s idle gap opened a new connection and took ~520-690 ms
// to a 401 response versus ~190-280 ms on a reused connection; with a 60 s
// keepAliveTimeout the same gaps reused the connection (0 new connections via
// the undici:client:connected diagnostics channel). Anthropic's edge held an
// idle connection >= 130 s in the same probe, so a 60 s client-side timeout
// still always closes the connection before the server does and cannot
// introduce new stale-socket races relative to the 4 s default.
//
// The dispatcher is an EnvHttpProxyAgent so HTTP(S)_PROXY/NO_PROXY behavior
// matches Pi's own global dispatcher. It is passed per-fetch instead of
// replacing Pi's global dispatcher so other extensions and Pi internals are
// untouched.
export const DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS = 60_000;

// Pi's fetch is undici's (Pi calls undici.install() with its own pinned copy),
// and a fetch implementation only accepts dispatchers speaking its own handler
// protocol version. This package pins the same undici major as Pi so the happy
// path works; if the runtime's fetch still rejects the dispatcher (e.g. an
// older bundled Node fetch outside Pi), the request is retried once without a
// dispatcher and keep-alive stays disabled for the rest of the process. The
// rejection happens synchronously inside dispatch, before any bytes are sent,
// so the retry can never double-send a request.
let dispatcherUnsupportedForProcess = false;
let cachedDispatcher: { keepAliveMs: number; dispatcher: EnvHttpProxyAgent } | undefined;

export function resolveNativeFetchKeepAliveMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PI_CLAUDE_HTTP_KEEPALIVE_MS;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS;
}

export function getNativeFetchDispatcher(
  env: Record<string, string | undefined> = process.env,
): EnvHttpProxyAgent | undefined {
  if (dispatcherUnsupportedForProcess) return undefined;

  const keepAliveMs = resolveNativeFetchKeepAliveMs(env);
  if (keepAliveMs <= 0) return undefined;

  if (cachedDispatcher?.keepAliveMs !== keepAliveMs) {
    cachedDispatcher = {
      keepAliveMs,
      dispatcher: new EnvHttpProxyAgent({ allowH2: false, keepAliveTimeout: keepAliveMs }),
    };
  }
  return cachedDispatcher.dispatcher;
}

// True for the synchronous handler-protocol rejection a fetch implementation
// raises when given a dispatcher from an incompatible undici copy: a
// TypeError("fetch failed") whose cause carries code UND_ERR_INVALID_ARG.
export function isDispatcherCompatibilityError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const cause = error.cause;
  return isRecord(cause) && cause.code === "UND_ERR_INVALID_ARG";
}

export function markNativeFetchDispatcherUnsupported(): void {
  dispatcherUnsupportedForProcess = true;
}

// Test-only: clears the process-level unsupported flag and the cached
// dispatcher so dispatcher tests stay order-independent.
export function resetNativeFetchDispatcherForTests(): void {
  dispatcherUnsupportedForProcess = false;
  cachedDispatcher = undefined;
}
