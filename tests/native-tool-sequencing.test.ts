import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";

import {
  assistantToolCallIds,
  hasCompleteImmediateToolResults,
  sentToolResultIndices,
  shouldReplayAssistantMessage,
} from "../src/native-tool-sequencing.ts";

const API = "claude-subscription-native";
const PROVIDER = "claude-subscription";

function assistant(toolCallIds: string[], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
    api: API,
    provider: PROVIDER,
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
    ...overrides,
  };
}

function toolResult(toolCallId: string, text = "result"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

test("assistantToolCallIds returns only toolCall block ids in order", () => {
  const message = assistant(["a", "b"]);
  message.content.unshift({ type: "text", text: "thinking out loud" });
  assert.deepEqual(assistantToolCallIds(message), ["a", "b"]);
});

test("shouldReplayAssistantMessage rejects error and aborted turns", () => {
  assert.equal(shouldReplayAssistantMessage(assistant(["a"], { stopReason: "toolUse" })), true);
  assert.equal(shouldReplayAssistantMessage(assistant(["a"], { stopReason: "error" })), false);
  assert.equal(shouldReplayAssistantMessage(assistant(["a"], { stopReason: "aborted" })), false);
});

test("hasCompleteImmediateToolResults requires every tool call to be answered immediately", () => {
  const complete: Message[] = [assistant(["a", "b"]), toolResult("a"), toolResult("b")];
  assert.equal(hasCompleteImmediateToolResults(complete, 0, ["a", "b"]), true);

  const missing: Message[] = [assistant(["a", "b"]), toolResult("a")];
  assert.equal(hasCompleteImmediateToolResults(missing, 0, ["a", "b"]), false);

  const interrupted: Message[] = [
    assistant(["a", "b"]),
    toolResult("a"),
    { role: "user", content: "interrupt", timestamp: 0 },
    toolResult("b"),
  ];
  assert.equal(hasCompleteImmediateToolResults(interrupted, 0, ["a", "b"]), false);
});

test("sentToolResultIndices includes complete immediate sequences and excludes orphans", () => {
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant(["a", "b"]),
    toolResult("a"), // index 2 - sent
    toolResult("b"), // index 3 - sent
    { role: "user", content: "next", timestamp: 0 },
    toolResult("orphan"), // index 5 - orphan, not sent
    assistant(["c"], { stopReason: "error" }),
    toolResult("c"), // index 7 - follows non-replayable assistant, not sent
  ];
  assert.deepEqual([...sentToolResultIndices(messages)].sort((x, y) => x - y), [2, 3]);
});

test("sentToolResultIndices marks all results of a complete parallel tool-call turn", () => {
  const messages: Message[] = [
    assistant(["a", "b", "c"]),
    toolResult("a"), // 1
    toolResult("b"), // 2
    toolResult("c"), // 3
    { role: "user", content: "thanks", timestamp: 0 },
  ];
  assert.deepEqual([...sentToolResultIndices(messages)].sort((x, y) => x - y), [1, 2, 3]);
});

test("sentToolResultIndices ignores an extra unmatched immediate result", () => {
  const messages: Message[] = [
    assistant(["a"]),
    toolResult("a"), // 1 - sent
    toolResult("unexpected"), // 2 - not one of the turn's ids, not sent
  ];
  assert.deepEqual([...sentToolResultIndices(messages)], [1]);
});

test("sentToolResultIndices excludes an incomplete trailing sequence", () => {
  const messages: Message[] = [
    assistant(["a", "b"]),
    toolResult("a"), // present
    // "b" never answered -> whole assistant turn's results are not sent
  ];
  assert.deepEqual([...sentToolResultIndices(messages)], []);
});

test("sentToolResultIndices stops a turn's results at the first interleaved non-result", () => {
  const messages: Message[] = [
    assistant(["a", "b"]),
    toolResult("a"), // 1
    { role: "user", content: "wait", timestamp: 0 }, // breaks the immediate run
    toolResult("b"), // 3 - no longer immediate, sequence incomplete -> none sent
  ];
  assert.deepEqual([...sentToolResultIndices(messages)], []);
});

test("sentToolResultIndices documents duplicate-id behavior (both marked)", () => {
  // Pi emits one result per tool-call id; this fixture is intentionally
  // degenerate. It documents that sequencing mirrors convertMessages by marking
  // every matching immediate result, so neither hides a malformed transcript.
  const messages: Message[] = [
    assistant(["a"]),
    toolResult("a"), // 1
    toolResult("a"), // 2 - duplicate id, still immediate and matching
  ];
  assert.deepEqual([...sentToolResultIndices(messages)].sort((x, y) => x - y), [1, 2]);
});
