import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS,
  getNativeFetchDispatcher,
  isDispatcherCompatibilityError,
  markNativeFetchDispatcherUnsupported,
  resetNativeFetchDispatcherForTests,
  resolveNativeFetchKeepAliveMs,
} from "../src/native-fetch-dispatcher.ts";

test("resolveNativeFetchKeepAliveMsDefaultsTo60s", () => {
  assert.equal(resolveNativeFetchKeepAliveMs({}), DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS);
  assert.equal(DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS, 60_000);
});

test("resolveNativeFetchKeepAliveMsHonorsEnvOverride", () => {
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "30000" }), 30_000);
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: " 15000 " }), 15_000);
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "0" }), 0);
});

test("resolveNativeFetchKeepAliveMsFallsBackOnInvalidValues", () => {
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "not-a-number" }), DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS);
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "-5" }), DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS);
  assert.equal(resolveNativeFetchKeepAliveMs({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "" }), DEFAULT_NATIVE_FETCH_KEEP_ALIVE_MS);
});

test("getNativeFetchDispatcherReturnsAProcessSingletonPerKeepAliveValue", () => {
  resetNativeFetchDispatcherForTests();
  try {
    const first = getNativeFetchDispatcher({});
    const second = getNativeFetchDispatcher({});
    assert.ok(first, "default env should produce a dispatcher");
    assert.equal(first, second, "same keep-alive value must reuse the same dispatcher instance");

    const overridden = getNativeFetchDispatcher({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "30000" });
    assert.ok(overridden);
    assert.notEqual(overridden, first, "a changed keep-alive value must rebuild the dispatcher");
  } finally {
    resetNativeFetchDispatcherForTests();
  }
});

test("getNativeFetchDispatcherIsDisabledByZeroEnvAndByProcessUnsupportedFlag", () => {
  resetNativeFetchDispatcherForTests();
  try {
    assert.equal(getNativeFetchDispatcher({ PI_CLAUDE_HTTP_KEEPALIVE_MS: "0" }), undefined);

    assert.ok(getNativeFetchDispatcher({}), "sanity: enabled before the unsupported flag");
    markNativeFetchDispatcherUnsupported();
    assert.equal(getNativeFetchDispatcher({}), undefined, "unsupported flag must disable the dispatcher for the process");
  } finally {
    resetNativeFetchDispatcherForTests();
  }
});

test("isDispatcherCompatibilityErrorMatchesOnlyTheUndiciInvalidArgShape", () => {
  assert.equal(
    isDispatcherCompatibilityError(new TypeError("fetch failed", { cause: { code: "UND_ERR_INVALID_ARG", message: "invalid onRequestStart method" } })),
    true,
  );
  const errorWithErrorCause = new TypeError("fetch failed");
  (errorWithErrorCause as { cause?: unknown }).cause = Object.assign(new Error("invalid onRequestStart method"), { code: "UND_ERR_INVALID_ARG" });
  assert.equal(isDispatcherCompatibilityError(errorWithErrorCause), true);

  assert.equal(isDispatcherCompatibilityError(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } })), false);
  assert.equal(isDispatcherCompatibilityError(new TypeError("fetch failed")), false);
  assert.equal(isDispatcherCompatibilityError(new Error("ECONNRESET")), false);
  assert.equal(isDispatcherCompatibilityError(undefined), false);
  assert.equal(isDispatcherCompatibilityError("fetch failed"), false);
});
