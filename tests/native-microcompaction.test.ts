import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";

import {
  DEFAULT_MICROCOMPACTION_KEEP_RECENT,
  TOOL_RESULT_CLEARED_PLACEHOLDER,
  disabledMicrocompactionConfig,
  projectMessagesForNativeMicrocompaction,
  resolveNativeMicrocompactionConfig,
  type NativeMicrocompactionConfig,
} from "../src/native-microcompaction.ts";

const API = "claude-subscription-native";
const PROVIDER = "claude-subscription";
const BIG = "x".repeat(5000);

function config(overrides: Partial<NativeMicrocompactionConfig> = {}): NativeMicrocompactionConfig {
  return { enabled: true, keepRecent: 1, minBytesSaved: 1, ...overrides };
}

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

function toolResult(toolCallId: string, text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
    ...overrides,
  };
}

// One complete assistant->toolResult sequence per id, each its own turn.
function sequence(ids: Array<{ id: string; text: string; overrides?: Partial<ToolResultMessage> }>): Message[] {
  const messages: Message[] = [];
  for (const { id, text, overrides } of ids) {
    messages.push(assistant([id]));
    messages.push(toolResult(id, text, overrides));
  }
  return messages;
}

test("disabled config is an identical no-op returning the same array reference", () => {
  const messages = sequence([{ id: "a", text: BIG }, { id: "b", text: BIG }]);
  const result = projectMessagesForNativeMicrocompaction(messages, disabledMicrocompactionConfig());
  assert.equal(result.messages, messages);
  assert.equal(result.stats.applied, false);
});

test("does not mutate the input messages", () => {
  const messages = sequence([{ id: "a", text: BIG }, { id: "b", text: BIG }, { id: "c", text: BIG }]);
  const snapshot = structuredClone(messages);
  projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  assert.deepEqual(messages, snapshot);
});

test("clears old clearable results and keeps the last keepRecent full", () => {
  const messages = sequence([
    { id: "a", text: BIG },
    { id: "b", text: BIG },
    { id: "c", text: BIG },
  ]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));

  assert.equal(result.stats.applied, true);
  assert.equal(result.stats.compactedResults, 2);
  assert.equal(result.stats.keptRecent, 1);
  assert.ok(result.stats.bytesSaved > 9000);

  const results = result.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
  assert.deepEqual(results[0].content, [{ type: "text", text: TOOL_RESULT_CLEARED_PLACEHOLDER }]);
  assert.deepEqual(results[1].content, [{ type: "text", text: TOOL_RESULT_CLEARED_PLACEHOLDER }]);
  assert.deepEqual(results[2].content, [{ type: "text", text: BIG }]);
});

test("preserves tool-result metadata on cleared results", () => {
  const messages = sequence([
    { id: "a", text: BIG, overrides: { toolName: "grep", timestamp: 42, details: { foo: 1 } } },
    { id: "b", text: BIG },
  ]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  const cleared = result.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
  assert.ok(cleared);
  assert.equal(cleared.toolCallId, "a");
  assert.equal(cleared.toolName, "grep");
  assert.equal(cleared.timestamp, 42);
  assert.equal(cleared.isError, false);
  assert.deepEqual(cleared.details, { foo: 1 });
});

test("skips error results and image-bearing results", () => {
  const messages: Message[] = [
    assistant(["err"]),
    toolResult("err", BIG, { isError: true }),
    assistant(["img"]),
    {
      role: "toolResult",
      toolCallId: "img",
      toolName: "read",
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      isError: false,
      timestamp: 0,
    },
    assistant(["ok"]),
    toolResult("ok", BIG),
  ];
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  // err is error (not a candidate), img is image (not a candidate), ok is the
  // only candidate and within keepRecent -> nothing cleared.
  assert.equal(result.stats.applied, false);
});

test("skips orphan/incomplete tool sequences and counts them", () => {
  const messages: Message[] = [
    assistant(["a", "b"]),
    toolResult("a", BIG),
    // "b" never answered -> the whole turn's results are not sent/eligible
    { role: "user", content: "next", timestamp: 0 },
    toolResult("orphan", BIG),
  ];
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  assert.equal(result.stats.applied, false);
  assert.equal(result.stats.skippedIncomplete, 2);
});

test("respects the minBytesSaved gate and returns the original array when below it", () => {
  const messages = sequence([
    { id: "a", text: "small" },
    { id: "b", text: "small" },
    { id: "c", text: "small" },
  ]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1, minBytesSaved: 100_000 }));
  assert.equal(result.stats.applied, false);
  assert.equal(result.messages, messages);
});

test("does not re-clear already-cleared results", () => {
  const messages = sequence([
    { id: "a", text: TOOL_RESULT_CLEARED_PLACEHOLDER },
    { id: "b", text: BIG },
    { id: "c", text: BIG },
  ]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  // a already cleared (skipped), b cleared, c kept.
  assert.equal(result.stats.compactedResults, 1);
});

test("treats <persisted-output> content as already cleared", () => {
  const messages = sequence([
    { id: "a", text: "<persisted-output>ref-123</persisted-output>" },
    { id: "b", text: BIG },
    { id: "c", text: BIG },
  ]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1 }));
  // a is already-cleared (persisted-output) and skipped; only b is cleared, c kept.
  assert.equal(result.stats.compactedResults, 1);
});

test("sums byte savings across multiple text blocks for the gate", () => {
  const multiBlock: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "multi",
    toolName: "read",
    content: [
      { type: "text", text: "y".repeat(3000) },
      { type: "text", text: "z".repeat(3000) },
    ],
    isError: false,
    timestamp: 0,
  };
  const messages: Message[] = [
    assistant(["multi"]),
    multiBlock,
    assistant(["recent"]),
    toolResult("recent", BIG),
  ];
  // Gate sits between a single block (3000) and the two-block sum (~6000): only
  // passes because both text blocks are counted.
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 1, minBytesSaved: 5000 }));
  assert.equal(result.stats.applied, true);
  assert.equal(result.stats.compactedResults, 1);
  assert.ok(result.stats.bytesSaved >= 5900);
});

test("keepRecent is floored to 1", () => {
  const messages = sequence([{ id: "a", text: BIG }, { id: "b", text: BIG }]);
  const result = projectMessagesForNativeMicrocompaction(messages, config({ keepRecent: 0 }));
  assert.equal(result.stats.keptRecent, 1);
  assert.equal(result.stats.compactedResults, 1);
});

test("resolveNativeMicrocompactionConfig is disabled unless PI_CLAUDE_MICROCOMPACT is truthy", () => {
  assert.deepEqual(resolveNativeMicrocompactionConfig({}), disabledMicrocompactionConfig());
  assert.equal(resolveNativeMicrocompactionConfig({ PI_CLAUDE_MICROCOMPACT: "0" }).enabled, false);

  const enabled = resolveNativeMicrocompactionConfig({ PI_CLAUDE_MICROCOMPACT: "1" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.keepRecent, DEFAULT_MICROCOMPACTION_KEEP_RECENT);

  const tuned = resolveNativeMicrocompactionConfig({
    PI_CLAUDE_MICROCOMPACT: "true",
    PI_CLAUDE_MICROCOMPACT_KEEP_RECENT: "3",
    PI_CLAUDE_MICROCOMPACT_MIN_BYTES: "2048",
  });
  assert.equal(tuned.keepRecent, 3);
  assert.equal(tuned.minBytesSaved, 2048);
});
