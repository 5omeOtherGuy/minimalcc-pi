import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";

// Shared Anthropic tool-sequencing predicates. These encode the single rule for
// which Pi tool results are safe to send to Anthropic: a tool result is only
// valid when it immediately follows the assistant turn that requested it and
// that turn's tool calls are all answered. `convertMessages` (the Pi -> Anthropic
// payload builder) and the microcompaction projection both consume these exact
// predicates so there is never a divergent second copy of the sequencing rules.

// Aborted/errored assistant turns are never replayed, so their tool results are
// not sent either. Mirrors the stop reasons Anthropic rejects on replay.
export function shouldReplayAssistantMessage(message: AssistantMessage): boolean {
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

export function assistantToolCallIds(message: AssistantMessage): string[] {
  return message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map((block) => block.id);
}

export function immediatelyFollowingToolResultIds(messages: readonly Message[], assistantIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let index = assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "toolResult") break;
    ids.add(message.toolCallId);
  }
  return ids;
}

export function hasCompleteImmediateToolResults(
  messages: readonly Message[],
  assistantIndex: number,
  toolCallIds: readonly string[],
): boolean {
  if (toolCallIds.length === 0) return true;
  const toolResultIds = immediatelyFollowingToolResultIds(messages, assistantIndex);
  return toolCallIds.every((id) => toolResultIds.has(id));
}

// Indices of `toolResult` messages that `convertMessages` would actually emit as
// Anthropic `tool_result` blocks: those immediately following a replayable
// assistant turn whose tool calls are all answered, matching one of that turn's
// tool-call ids. Orphan/incomplete tool results are excluded. This is the
// authoritative "what gets sent" set shared by conversion and microcompaction.
//
// Assumption: Pi produces exactly one ToolResultMessage per tool-call id (its
// harness runs each tool call once and emits a single result). Anthropic rejects
// two `tool_result` blocks for the same `tool_use_id`, so if a transcript ever
// contained duplicate results for one id, both `convertMessages` and this
// function would mark/emit them and the request would fail at conversion -- a
// pre-existing condition that microcompaction neither introduces nor masks.
export function sentToolResultIndices(messages: readonly Message[]): Set<number> {
  const indices = new Set<number>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant") continue;
    if (!shouldReplayAssistantMessage(message)) continue;

    const toolCallIds = assistantToolCallIds(message);
    if (toolCallIds.length === 0) continue;
    if (!hasCompleteImmediateToolResults(messages, messageIndex, toolCallIds)) continue;

    const expected = new Set(toolCallIds);
    for (let index = messageIndex + 1; index < messages.length; index++) {
      const following = messages[index];
      if (following?.role !== "toolResult") break;
      if (expected.has(following.toolCallId)) indices.add(index);
    }
  }

  return indices;
}
