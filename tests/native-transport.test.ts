import assert from "node:assert/strict";
import test from "node:test";

import { ANTHROPIC_MESSAGES_URL, buildNativeMessagesRequest } from "../src/native-request.ts";
import { NativeTransportError, postNativeMessagesRequest } from "../src/native-transport.ts";
import { redactSensitiveText } from "../src/redaction.ts";

const FAKE_TOKEN = "fake-native-transport-oauth-token";

function payload() {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system: "Pi system prompt",
  };
}

function request() {
  return buildNativeMessagesRequest({
    accessToken: FAKE_TOKEN,
    payload: payload(),
  });
}

type CapturedFetchCall = {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

test("postsToAnthropicMessagesEndpoint", async () => {
  const calls: CapturedFetchCall[] = [];
  const responseBody = { id: "msg_fake", type: "message", content: [] };

  const fakeFetch = async (url: string, init: CapturedFetchCall["init"]): Promise<Response> => {
    calls.push({ url, init });
    return jsonResponse(responseBody, { status: 200 });
  };

  const result = await postNativeMessagesRequest(request(), { fetch: fakeFetch });

  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ANTHROPIC_MESSAGES_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), request().body);
});

test("sendsOnlyOAuthHeadersToMockServer", async () => {
  const calls: CapturedFetchCall[] = [];
  const fakeFetch = async (url: string, init: CapturedFetchCall["init"]): Promise<Response> => {
    calls.push({ url, init });
    return jsonResponse({ ok: true }, { status: 200 });
  };

  await postNativeMessagesRequest(request(), { fetch: fakeFetch });

  const headers = calls[0].init.headers ?? {};
  assert.equal(headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.match(headers["anthropic-beta"], /oauth-2025-04-20/);
  assert.deepEqual(Object.keys(headers).sort(), [
    "Authorization",
    "Content-Type",
    "anthropic-beta",
    "anthropic-version",
  ]);

  const lowerKeys = Object.keys(headers).map((key) => key.toLowerCase());
  assert.ok(!lowerKeys.includes("x-api-key"), "must not send x-api-key");
  assert.ok(!lowerKeys.includes("anthropic-api-key"), "must not send API-key aliases");
});

test("mapsAnthropicErrorWithoutLeakingAuthorization", async () => {
  const fakeFetch = async (): Promise<Response> => jsonResponse(
    {
      type: "error",
      error: {
        type: "authentication_error",
        message: `invalid auth from Authorization: Bearer ${FAKE_TOKEN}; bare token echo ${FAKE_TOKEN}`,
      },
    },
    { status: 401, headers: { "request-id": "req_mock_123" } },
  );

  await assert.rejects(
    () => postNativeMessagesRequest(request(), { fetch: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof NativeTransportError, "must throw NativeTransportError");
      assert.equal(err.status, 401);
      assert.equal(err.type, "authentication_error");
      assert.equal(err.requestId, "req_mock_123");
      assert.match(err.message, /authentication_error/);
      assert.match(err.message, /invalid auth/);
      assert.match(err.message, /req_mock_123/);
      assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
      assert.ok(!err.message.includes(`Bearer ${FAKE_TOKEN}`), "must not leak Authorization value");
      return true;
    },
  );

  const redacted = redactSensitiveText(
    `Authorization: Bearer ${FAKE_TOKEN}; bare token echo ${FAKE_TOKEN}`,
    [FAKE_TOKEN],
  );
  assert.ok(!redacted.includes(FAKE_TOKEN));
  assert.match(redacted, /REDACTED/);
});

test("mapsNonJsonAnthropicErrorBodyWithRequestId", async () => {
  const fakeFetch = async (): Promise<Response> => new Response("Rate limit exceeded", {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "request-id": "req_429_plain" },
  });

  await assert.rejects(
    () => postNativeMessagesRequest(request(), { fetch: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof NativeTransportError, "must throw NativeTransportError");
      assert.equal(err.status, 429);
      assert.equal(err.type, undefined);
      assert.equal(err.requestId, "req_429_plain");
      assert.match(err.message, /Rate limit exceeded/);
      assert.match(err.message, /req_429_plain/);
      return true;
    },
  );
});

test("mapsFetchNetworkErrorsWithoutLeakingAuthorization", async () => {
  const fakeFetch = async (): Promise<never> => {
    throw new Error(`connect ECONNREFUSED Authorization: Bearer ${FAKE_TOKEN}`);
  };

  await assert.rejects(
    () => postNativeMessagesRequest(request(), { fetch: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof NativeTransportError, "must throw NativeTransportError");
      assert.equal(err.status, 0);
      assert.match(err.message, /transport error/i);
      assert.match(err.message, /ECONNREFUSED/);
      assert.match(err.message, /REDACTED/);
      assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak OAuth token");
      assert.ok(!err.message.includes(`Bearer ${FAKE_TOKEN}`), "must not leak Authorization value");
      return true;
    },
  );
});

test("doesNotRequireLocalhost4050", async () => {
  const calls: CapturedFetchCall[] = [];
  const fakeFetch = async (url: string, init: CapturedFetchCall["init"]): Promise<Response> => {
    assert.ok(!url.includes("localhost"), "must not route through localhost");
    assert.ok(!url.includes("127.0.0.1"), "must not route through localhost IP");
    assert.ok(!url.includes(":4050"), "must not route through CCProxy port 4050");
    calls.push({ url, init });
    return jsonResponse({ ok: true }, { status: 200 });
  };

  await postNativeMessagesRequest(request(), { fetch: fakeFetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
});
