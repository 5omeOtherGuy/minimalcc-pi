import { CLAUDE_CODE_IDENTITY, DOC_ROUTING_PREFIXES } from "./constants.ts";

type TextBlock = { type: "text"; text: string; cache_control?: unknown };

type Payload = Record<string, unknown>;

export function sanitizePiPrompt(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !DOC_ROUTING_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
    })
    .join("\n")
    .trim();
}

function isTextBlock(value: unknown): value is TextBlock {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "text"
    && typeof (value as { text?: unknown }).text === "string";
}

function textBlock(text: string, cacheControl?: unknown): TextBlock {
  return {
    type: "text",
    text,
    ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
  };
}

function isIdentityText(text: string): boolean {
  return text.trim() === CLAUDE_CODE_IDENTITY;
}

function splitIdentityPrefix(text: string): string {
  const trimmed = text.trim();
  if (trimmed === CLAUDE_CODE_IDENTITY) return "";
  if (trimmed.startsWith(CLAUDE_CODE_IDENTITY)) {
    return trimmed.slice(CLAUDE_CODE_IDENTITY.length).trim();
  }
  return trimmed;
}

function extractSystemText(system: unknown): { text: string; identityCacheControl?: unknown; cacheControl?: unknown } {
  const parts = Array.isArray(system) ? system : [system];
  const texts: string[] = [];
  let identityCacheControl: unknown;
  let cacheControl: unknown;

  for (const part of parts) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (isTextBlock(part)) {
      if (isIdentityText(part.text)) {
        if (identityCacheControl === undefined && "cache_control" in part) {
          identityCacheControl = part.cache_control;
        }
      } else {
        texts.push(part.text);
        if (cacheControl === undefined && "cache_control" in part) {
          cacheControl = part.cache_control;
        }
      }
    }
  }

  return {
    text: sanitizePiPrompt(splitIdentityPrefix(texts.join("\n\n"))),
    identityCacheControl,
    cacheControl,
  };
}

export function shouldShapePayload(payload: unknown): payload is Payload {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Payload;
  return typeof record.model === "string"
    && record.model.startsWith("claude-")
    && Array.isArray(record.messages)
    && "max_tokens" in record;
}

export function shapeSystemBlocks(payload: Payload): Payload {
  const { text, identityCacheControl, cacheControl } = extractSystemText(payload.system);
  return {
    ...payload,
    system: [
      textBlock(CLAUDE_CODE_IDENTITY, identityCacheControl),
      ...(text ? [textBlock(text, cacheControl)] : []),
    ],
  };
}
