import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StopReason,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { type AnthropicSseEvent } from "./anthropic-sse.ts";
import { normalizeEditToolArguments } from "./edit-tool-arguments.ts";
import {
  parseFinalToolArgumentsFromJson,
  parseToolArgumentsFromJson,
} from "./tool-json-arguments.ts";
import { isRecord } from "./type-guards.ts";

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

export type NativeStreamEventState = {
  contractState: NativeStreamContractState;
  contentIndexByAnthropicIndex: Map<number, number>;
  toolJsonByContentIndex: ToolJsonState;
};

export function createNativeStreamEventState(): NativeStreamEventState {
  return {
    contractState: {
      sawMessageStart: false,
      sawMessageStop: false,
      fallbackBlockIndexes: new Set(),
    },
    contentIndexByAnthropicIndex: new Map(),
    toolJsonByContentIndex: new Map(),
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

export function applyAnthropicEvent(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  output: AssistantMessage,
  event: AnthropicSseEvent,
  eventState: NativeStreamEventState,
): void {
  const { contentIndexByAnthropicIndex, contractState, toolJsonByContentIndex } = eventState;

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

export function activeToolDiagnosticParts(eventState: NativeStreamEventState): string[] {
  const activeTools = [...eventState.toolJsonByContentIndex.entries()];
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
