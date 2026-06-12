import { redactSensitiveText } from "./redaction.ts";
import { isRecord } from "./type-guards.ts";

export type AnthropicSseEvent =
  | { type: "messageStart"; responseId?: string; model?: string; usage?: unknown }
  | { type: "redactedThinkingStart"; index: number; data: string }
  | { type: "textStart"; index: number; text: string }
  | { type: "textDelta"; index: number; text: string }
  | { type: "thinkingStart"; index: number; thinking: string }
  | { type: "thinkingDelta"; index: number; thinking: string }
  | { type: "signatureDelta"; index: number; signature: string }
  | { type: "toolUseStart"; index: number; id: string; name: string; input: unknown }
  | { type: "toolUseInputDelta"; index: number; partialJson: string }
  // Server-side refusal fallback marker (Fable 5): an ordinary content block of
  // type "fallback" marking where the API switched to the fallback model.
  | { type: "fallbackStart"; index: number; fromModel?: string; toModel?: string }
  | { type: "contentBlockStop"; index: number }
  | { type: "messageDelta"; stopReason?: string; stopDetailsCategory?: string; usage?: unknown }
  | { type: "contractViolation"; code: "tool_use_stop_without_tool_use_block"; responseId?: string; stopReason: "tool_use"; message: string }
  | { type: "messageStop"; stopReason?: string };

export type ParseAnthropicSseOptions = {
  knownSecrets?: readonly string[];
};

export class AnthropicSseParseError extends Error {
  frameIndex: number;

  constructor(message: string, options: { frameIndex: number }) {
    super(message);
    this.name = "AnthropicSseParseError";
    this.frameIndex = options.frameIndex;
  }
}

type SseFrame = {
  event?: string;
  data: string;
};

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseFrames(sse: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let event: string | undefined;
  const dataLines: string[] = [];

  function flush(): void {
    if (dataLines.length === 0) {
      event = undefined;
      return;
    }

    frames.push({ event, data: dataLines.join("\n") });
    event = undefined;
    dataLines.length = 0;
  }

  let lineStart = 0;
  while (lineStart <= sse.length) {
    const newlineIndex = sse.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? sse.length : newlineIndex;
    const rawLineEnd = lineEnd > lineStart && sse.charCodeAt(lineEnd - 1) === 13
      ? lineEnd - 1
      : lineEnd;

    if (rawLineEnd === lineStart) {
      flush();
    } else if (sse.charCodeAt(lineStart) !== 58) {
      let separator = -1;
      for (let index = lineStart; index < rawLineEnd; index += 1) {
        if (sse.charCodeAt(index) === 58) {
          separator = index;
          break;
        }
      }
      const hasSeparator = separator !== -1;
      const field = hasSeparator ? sse.slice(lineStart, separator) : sse.slice(lineStart, rawLineEnd);
      const valueStart = hasSeparator
        ? separator + (sse.charCodeAt(separator + 1) === 32 ? 2 : 1)
        : rawLineEnd;
      const value = hasSeparator ? sse.slice(valueStart, rawLineEnd) : "";

      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  flush();
  return frames;
}

function parseFrameData(frame: SseFrame, frameIndex: number, knownSecrets: readonly string[]): unknown {
  if (frame.data === "[DONE]") return undefined;

  try {
    return JSON.parse(frame.data);
  } catch {
    throw new AnthropicSseParseError(
      `Malformed Anthropic SSE JSON at frame ${frameIndex} (dataBytes=${Buffer.byteLength(frame.data, "utf8")}).`,
      { frameIndex },
    );
  }
}

function eventType(frame: SseFrame, data: unknown): string | undefined {
  if (isRecord(data) && typeof data.type === "string") return data.type;
  return frame.event;
}

type OpenContentBlock = {
  type: "text" | "thinking" | "redacted_thinking" | "tool_use" | "fallback";
};

function throwParseError(message: string, frameIndex: number, knownSecrets: readonly string[]): never {
  throw new AnthropicSseParseError(redactSensitiveText(message, knownSecrets), { frameIndex });
}

function throwMissingMessageStart(frameIndex: number, knownSecrets: readonly string[]): never {
  throwParseError("Anthropic stream contract violation: missing message_start.", frameIndex, knownSecrets);
}

function throwAnthropicErrorFrame(data: Record<string, unknown>, frameIndex: number, knownSecrets: readonly string[]): never {
  const error = isRecord(data.error) ? data.error : data;
  const errorType = stringValue(error.type) || "unknown_error";
  const errorMessage = stringValue(error.message) || "Anthropic returned an error event.";
  throwParseError(`Anthropic SSE error ${errorType}: ${errorMessage}`, frameIndex, knownSecrets);
}

export function parseAnthropicSse(
  sse: string,
  options: ParseAnthropicSseOptions = {},
): AnthropicSseEvent[] {
  const parser = new AnthropicSseIncrementalParser(options);
  const events: AnthropicSseEvent[] = [];
  for (const frame of parseFrames(sse)) {
    events.push(...parser.pushFrame(frame));
  }
  parser.finish();
  return events;
}

export class AnthropicSseIncrementalParser {
  private openBlocks = new Map<number, OpenContentBlock>();
  private responseId: string | undefined;
  private stopReason: string | undefined;
  private sawMessageStart = false;
  private sawMessageStop = false;
  private sawToolUseBlock = false;
  private frameIndex = 0;
  private readonly knownSecrets: readonly string[];

  constructor(options: ParseAnthropicSseOptions = {}) {
    this.knownSecrets = options.knownSecrets ?? [];
  }

  pushFrame(frame: SseFrame): AnthropicSseEvent[] {
    const currentFrameIndex = this.frameIndex++;
    const events: AnthropicSseEvent[] = [];
    const data = parseFrameData(frame, currentFrameIndex, this.knownSecrets);
    if (data === undefined) return events;

    const type = eventType(frame, data);
    if (!isRecord(data)) return events;

    if (frame.event === "error" || type === "error") {
      throwAnthropicErrorFrame(data, currentFrameIndex, this.knownSecrets);
    }

    if (type === "message_start") {
      if (this.sawMessageStart && !this.sawMessageStop) {
        throwParseError("Anthropic stream contract violation: duplicate message_start before message_stop.", currentFrameIndex, this.knownSecrets);
      }

      const message = isRecord(data.message) ? data.message : {};
      this.responseId = typeof message.id === "string" ? message.id : undefined;
      this.stopReason = undefined;
      this.sawMessageStart = true;
      this.sawMessageStop = false;
      this.sawToolUseBlock = false;
      this.openBlocks.clear();
      events.push({
        type: "messageStart",
        ...(this.responseId ? { responseId: this.responseId } : {}),
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        ...("usage" in message ? { usage: message.usage } : {}),
      });
      return events;
    }

    if (type === "content_block_start") {
      if (!this.sawMessageStart) throwMissingMessageStart(currentFrameIndex, this.knownSecrets);
      if (this.sawMessageStop) {
        throwParseError("Anthropic stream contract violation: content_block_start after message_stop.", currentFrameIndex, this.knownSecrets);
      }

      const index = numberValue(data.index);
      if (this.openBlocks.has(index)) {
        throwParseError("Anthropic stream contract violation: duplicate content_block_start for open block.", currentFrameIndex, this.knownSecrets);
      }

      const block = isRecord(data.content_block) ? data.content_block : {};
      const blockType = block.type;

      if (blockType === "text") {
        this.openBlocks.set(index, { type: "text" });
        events.push({ type: "textStart", index, text: stringValue(block.text) });
      } else if (blockType === "thinking") {
        this.openBlocks.set(index, { type: "thinking" });
        events.push({ type: "thinkingStart", index, thinking: stringValue(block.thinking) });
      } else if (blockType === "redacted_thinking") {
        this.openBlocks.set(index, { type: "redacted_thinking" });
        events.push({ type: "redactedThinkingStart", index, data: stringValue(block.data) });
      } else if (blockType === "tool_use") {
        const id = stringValue(block.id);
        const name = stringValue(block.name);
        if (id.trim().length === 0 || name.trim().length === 0) {
          throwParseError("Anthropic stream contract violation: tool_use requires non-empty id and name.", currentFrameIndex, this.knownSecrets);
        }
        if ("input" in block && !isRecord(block.input)) {
          throwParseError("Anthropic stream contract violation: tool_use input must be an object.", currentFrameIndex, this.knownSecrets);
        }

        this.sawToolUseBlock = true;
        this.openBlocks.set(index, { type: "tool_use" });
        events.push({
          type: "toolUseStart",
          index,
          id,
          name,
          input: "input" in block ? block.input : {},
        });
      } else if (blockType === "fallback") {
        const fromModel = isRecord(block.from) ? stringValue(block.from.model) : "";
        const toModel = isRecord(block.to) ? stringValue(block.to.model) : "";
        this.openBlocks.set(index, { type: "fallback" });
        events.push({
          type: "fallbackStart",
          index,
          ...(fromModel ? { fromModel } : {}),
          ...(toModel ? { toModel } : {}),
        });
      }
      return events;
    }

    if (type === "content_block_delta") {
      if (!this.sawMessageStart) throwMissingMessageStart(currentFrameIndex, this.knownSecrets);
      const index = numberValue(data.index);
      const openBlock = this.openBlocks.get(index);
      if (!openBlock) {
        throwParseError("Anthropic stream contract violation: content_block_delta without content_block_start.", currentFrameIndex, this.knownSecrets);
      }

      const delta = isRecord(data.delta) ? data.delta : {};
      const deltaType = delta.type;

      if (deltaType === "text_delta") {
        events.push({ type: "textDelta", index, text: stringValue(delta.text) });
      } else if (deltaType === "thinking_delta") {
        events.push({ type: "thinkingDelta", index, thinking: stringValue(delta.thinking) });
      } else if (deltaType === "signature_delta") {
        events.push({ type: "signatureDelta", index, signature: stringValue(delta.signature) });
      } else if (deltaType === "input_json_delta") {
        if (openBlock.type !== "tool_use") {
          throwParseError("Anthropic stream contract violation: input_json_delta outside tool_use block.", currentFrameIndex, this.knownSecrets);
        }
        events.push({ type: "toolUseInputDelta", index, partialJson: stringValue(delta.partial_json) });
      }
      return events;
    }

    if (type === "content_block_stop") {
      if (!this.sawMessageStart) throwMissingMessageStart(currentFrameIndex, this.knownSecrets);
      const index = numberValue(data.index);
      const openBlock = this.openBlocks.get(index);
      if (!openBlock) {
        throwParseError("Anthropic stream contract violation: content_block_stop without content_block_start.", currentFrameIndex, this.knownSecrets);
      }
      this.openBlocks.delete(index);
      events.push({ type: "contentBlockStop", index });
      return events;
    }

    if (type === "message_delta") {
      if (!this.sawMessageStart) throwMissingMessageStart(currentFrameIndex, this.knownSecrets);
      const delta = isRecord(data.delta) ? data.delta : {};
      this.stopReason = typeof delta.stop_reason === "string" ? delta.stop_reason : this.stopReason;
      // stop_details is informational (refusal policy category); never branch
      // on it for control flow -- it can be null even on a refusal.
      const stopDetails = isRecord(delta.stop_details) ? delta.stop_details : undefined;
      const stopDetailsCategory = stopDetails ? stringValue(stopDetails.category) : "";
      events.push({
        type: "messageDelta",
        ...(this.stopReason ? { stopReason: this.stopReason } : {}),
        ...(stopDetailsCategory ? { stopDetailsCategory } : {}),
        ...("usage" in data ? { usage: data.usage } : {}),
      });
      return events;
    }

    if (type === "message_stop") {
      if (!this.sawMessageStart) throwMissingMessageStart(currentFrameIndex, this.knownSecrets);
      if (this.openBlocks.size > 0) {
        throwParseError("Anthropic stream contract violation: missing content_block_stop before message_stop.", currentFrameIndex, this.knownSecrets);
      }

      if (this.stopReason === "tool_use" && !this.sawToolUseBlock) {
        events.push({
          type: "contractViolation",
          code: "tool_use_stop_without_tool_use_block",
          ...(this.responseId ? { responseId: this.responseId } : {}),
          stopReason: "tool_use",
          message: "Anthropic stream contract violation: stop_reason=tool_use without a tool_use content block.",
        });
      }

      this.sawMessageStop = true;
      events.push({
        type: "messageStop",
        ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      });
    }

    return events;
  }

  finish(): void {
    const finalFrameIndex = Math.max(0, this.frameIndex - 1);
    if (!this.sawMessageStart) throwMissingMessageStart(finalFrameIndex, this.knownSecrets);
    if (!this.sawMessageStop) {
      throwParseError("Anthropic stream contract violation: missing message_stop.", finalFrameIndex, this.knownSecrets);
    }
  }
}

function extractNextFrame(buffer: string): { frame: string; rest: string } | undefined {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const indexes = [lfIndex, crlfIndex].filter((index) => index >= 0);
  if (indexes.length === 0) return undefined;
  const index = Math.min(...indexes);
  const delimiterLength = index === crlfIndex ? 4 : 2;
  return { frame: buffer.slice(0, index), rest: buffer.slice(index + delimiterLength) };
}

export async function* parseAnthropicSseStream(
  chunks: AsyncIterable<string>,
  options: ParseAnthropicSseOptions = {},
): AsyncGenerator<AnthropicSseEvent> {
  const parser = new AnthropicSseIncrementalParser(options);
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    let next: { frame: string; rest: string } | undefined;
    while ((next = extractNextFrame(buffer))) {
      buffer = next.rest;
      for (const frame of parseFrames(`${next.frame}\n\n`)) {
        for (const event of parser.pushFrame(frame)) yield event;
      }
    }
  }

  if (buffer.trim().length > 0) {
    for (const frame of parseFrames(`${buffer}\n\n`)) {
      for (const event of parser.pushFrame(frame)) yield event;
    }
  }

  parser.finish();
}
