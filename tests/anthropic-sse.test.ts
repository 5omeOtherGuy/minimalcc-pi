import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicSseParseError,
  parseAnthropicSse,
  parseAnthropicSseStream,
} from "../src/anthropic-sse.ts";

const FAKE_TOKEN = "fake-sse-oauth-token-for-redaction";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* stringChunks(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

async function collectSseStreamEvents(chunks: string[]): Promise<ReturnType<typeof parseAnthropicSse>> {
  const events: ReturnType<typeof parseAnthropicSse> = [];
  for await (const event of parseAnthropicSseStream(stringChunks(chunks))) events.push(event);
  return events;
}

test("parsesTextSseEvents", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_text", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.deepEqual(events, [
    { type: "messageStart", responseId: "msg_text", model: "claude-sonnet-4-6" },
    { type: "textStart", index: 0, text: "" },
    { type: "textDelta", index: 0, text: "Hello" },
    { type: "textDelta", index: 0, text: " world" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 5 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);
});

test("parsesCrLfFramesAndFinalFrameWithoutTrailingBlankLine", () => {
  const crlfSse = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_crlf", model: "claude-sonnet-4-6", content: [] },
    }),
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("").replaceAll("\n", "\r\n");

  assert.deepEqual(parseAnthropicSse(crlfSse), [
    { type: "messageStart", responseId: "msg_crlf", model: "claude-sonnet-4-6" },
    { type: "messageStop" },
  ]);
});

test("parsesMultilineDataAndIgnoresCommentsUnknownFieldsAndDone", () => {
  const sse = [
    ": keepalive comment ignored",
    "unknown: ignored",
    "event: message_start",
    "data: {\"type\":\"message_start\",",
    "data: \"message\":{\"id\":\"msg_multidata\",\"model\":\"claude-sonnet-4-6\",\"content\":[]}}",
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  assert.deepEqual(parseAnthropicSse(sse), [
    { type: "messageStart", responseId: "msg_multidata", model: "claude-sonnet-4-6" },
    { type: "messageStop" },
  ]);
});

test("parseAnthropicSseStreamHandlesCrlfDelimiterSplitAcrossChunks", async () => {
  const firstFrame = sseFrame("message_start", {
    type: "message_start",
    message: { id: "msg_split_crlf", model: "claude-sonnet-4-6", content: [] },
  }).replaceAll("\n", "\r\n");
  const secondFrame = sseFrame("message_stop", { type: "message_stop" }).replaceAll("\n", "\r\n");

  const splitInsideDelimiter = firstFrame.length - 2;
  const events = await collectSseStreamEvents([
    firstFrame.slice(0, splitInsideDelimiter),
    firstFrame.slice(splitInsideDelimiter),
    secondFrame,
  ]);

  assert.deepEqual(events, [
    { type: "messageStart", responseId: "msg_split_crlf", model: "claude-sonnet-4-6" },
    { type: "messageStop" },
  ]);
});

test("parsesThinkingSseEvents", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_thinking", model: "claude-opus-4-7", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "I should reason" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "fake-signature" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 9 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.deepEqual(events, [
    { type: "messageStart", responseId: "msg_thinking", model: "claude-opus-4-7" },
    { type: "thinkingStart", index: 0, thinking: "" },
    { type: "thinkingDelta", index: 0, thinking: "I should reason" },
    { type: "signatureDelta", index: 0, signature: "fake-signature" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 9 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);
});

test("parsesToolUseSseEvents", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_tool", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_fake", name: "bash", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"echo' },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: ' PI_OK"}' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 12 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.deepEqual(events, [
    { type: "messageStart", responseId: "msg_tool", model: "claude-sonnet-4-6" },
    { type: "toolUseStart", index: 0, id: "toolu_fake", name: "bash", input: {} },
    { type: "toolUseInputDelta", index: 0, partialJson: '{"command":"echo' },
    { type: "toolUseInputDelta", index: 0, partialJson: ' PI_OK"}' },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "tool_use", usage: { output_tokens: 12 } },
    { type: "messageStop", stopReason: "tool_use" },
  ]);
  assert.equal(events.some((event) => event.type === "contractViolation"), false);
});

test("handlesToolUseStopWithNoToolUseBlock", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_contract_gap", model: "claude-opus-4-7", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "You can invoke functions by writing a \"" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 23 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.equal(events.some((event) => event.type === "toolUseStart"), false);
  assert.deepEqual(events.at(-2), {
    type: "contractViolation",
    code: "tool_use_stop_without_tool_use_block",
    responseId: "msg_contract_gap",
    stopReason: "tool_use",
    message: "Anthropic stream contract violation: stop_reason=tool_use without a tool_use content block.",
  });
  assert.deepEqual(events.at(-1), { type: "messageStop", stopReason: "tool_use" });
});

test("handlesMalformedSseWithoutSecretOrPayloadLeakage", () => {
  const malformed = [
    "event: content_block_delta",
    `data: {"type":"content_block_delta","text":"Authorization: Bearer ${FAKE_TOKEN}","partial_json":"{\\"path\\":\\"/tmp/private-file\\",\\"command\\":\\"echo secret\\"}",`,
    "",
  ].join("\n");

  assert.throws(
    () => parseAnthropicSse(malformed, { knownSecrets: [FAKE_TOKEN] }),
    (err: unknown) => {
      assert.ok(err instanceof AnthropicSseParseError, "must throw AnthropicSseParseError");
      assert.equal(err.frameIndex, 0);
      assert.match(err.message, /Malformed Anthropic SSE JSON/);
      assert.match(err.message, /dataBytes=\d+/);
      assert.ok(!err.message.includes("REDACTED"), "metadata-only error should not include frame contents");
      assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak token from malformed SSE frame");
      assert.ok(!err.message.includes("/tmp/private-file"), "must not leak paths from malformed SSE frame");
      assert.ok(!err.message.includes("echo secret"), "must not leak commands from malformed SSE frame");
      assert.ok(!err.message.includes("partial_json"), "must not leak raw key names from malformed SSE frame");
      return true;
    },
  );
});

function assertParseContractError(sse: string, pattern: RegExp) {
  assert.throws(
    () => parseAnthropicSse(sse, { knownSecrets: [FAKE_TOKEN] }),
    (err: unknown) => {
      assert.ok(err instanceof AnthropicSseParseError, "must throw AnthropicSseParseError");
      assert.match(err.message, pattern);
      assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak token from SSE contract error");
      return true;
    },
  );
}

test("throwsOnAnthropicSseErrorEventWithRedaction", () => {
  assert.throws(
    () => parseAnthropicSse(sseFrame("error", {
      type: "error",
      error: { type: "api_error", message: `Authorization: Bearer ${FAKE_TOKEN} failed` },
    }), { knownSecrets: [FAKE_TOKEN] }),
    (err: unknown) => {
      assert.ok(err instanceof AnthropicSseParseError, "must throw AnthropicSseParseError");
      assert.equal(err.frameIndex, 0);
      assert.match(err.message, /Anthropic SSE error/);
      assert.match(err.message, /api_error/);
      assert.match(err.message, /REDACTED/);
      assert.ok(!err.message.includes(FAKE_TOKEN), "must not leak token from SSE error frame");
      return true;
    },
  );
});

test("throwsOnAnthropicSseTypeErrorWithoutEventName", () => {
  const sse = `data: ${JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: `Bearer ${FAKE_TOKEN} overloaded` },
  })}\n\n`;

  assertParseContractError(sse, /Anthropic SSE error.*overloaded_error/);
});

test("throwsOnTruncatedStreamWithoutMessageStop", () => {
  assertParseContractError([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_truncated", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
  ].join(""), /missing message_stop/);
});

test("throwsOnStreamWithoutMessageStart", () => {
  assertParseContractError(sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
  }), /missing message_start/);
});

test("throwsOnDuplicateMessageStartBeforeMessageStop", () => {
  assertParseContractError([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_first", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_duplicate", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""), /duplicate message_start/);
});

test("throwsOnContentBlockStartAfterMessageStop", () => {
  assertParseContractError([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_done", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    sseFrame("message_stop", { type: "message_stop" }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ].join(""), /content_block_start after message_stop/);
});

test("throwsOnInputJsonDeltaForTextBlock", () => {
  assertParseContractError([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_mismatch", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"x\":1}" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""), /input_json_delta outside tool_use/);
});

test("throwsOnToolUseMissingIdOrName", () => {
  for (const contentBlock of [
    { type: "tool_use", name: "bash", input: {} },
    { type: "tool_use", id: "", name: "bash", input: {} },
    { type: "tool_use", id: "toolu_fake", input: {} },
    { type: "tool_use", id: "toolu_fake", name: "", input: {} },
  ]) {
    assertParseContractError([
      sseFrame("message_start", {
        type: "message_start",
        message: { id: "msg_bad_tool", model: "claude-sonnet-4-6", content: [] },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: contentBlock,
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      sseFrame("message_stop", { type: "message_stop" }),
    ].join(""), /tool_use.*id.*name/);
  }
});

test("throwsOnToolUseMissingContentBlockStopBeforeMessageStop", () => {
  assertParseContractError([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_open_tool", model: "claude-sonnet-4-6", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_fake", name: "bash", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""), /content_block_stop/);
});

test("preservesMalformedFineGrainedToolInputDeltasWithoutFailingSseParse", () => {
  for (const partialJson of [`{ "command": "Bearer ${FAKE_TOKEN}"`, "[]"]) {
    const events = parseAnthropicSse([
      sseFrame("message_start", {
        type: "message_start",
        message: { id: "msg_bad_json", model: "claude-sonnet-4-6", content: [] },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_fake", name: "bash", input: {} },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partialJson },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      sseFrame("message_stop", { type: "message_stop" }),
    ].join(""), { knownSecrets: [FAKE_TOKEN] });

    assert.deepEqual(events.slice(1, -2), [
      { type: "toolUseStart", index: 0, id: "toolu_fake", name: "bash", input: {} },
      { type: "toolUseInputDelta", index: 0, partialJson },
      { type: "contentBlockStop", index: 0 },
    ]);
    assert.deepEqual(events.at(-1), { type: "messageStop", stopReason: "tool_use" });
  }
});

test("capturesMessageStartUsage", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_usage_start",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "done" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 7 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.deepEqual(events[0], {
    type: "messageStart",
    responseId: "msg_usage_start",
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    },
  });
});

test("parsesRedactedThinkingSseEvents", () => {
  const events = parseAnthropicSse([
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_redacted", model: "claude-opus-4-7", content: [] },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "encrypted-thinking-payload" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join(""));

  assert.deepEqual(events, [
    { type: "messageStart", responseId: "msg_redacted", model: "claude-opus-4-7" },
    { type: "redactedThinkingStart", index: 0, data: "encrypted-thinking-payload" },
    { type: "contentBlockStop", index: 0 },
    { type: "messageDelta", stopReason: "end_turn", usage: { output_tokens: 1 } },
    { type: "messageStop", stopReason: "end_turn" },
  ]);
});
