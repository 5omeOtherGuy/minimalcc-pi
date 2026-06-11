import { buildNativeHeaders } from "./native-headers.ts";
import { shapeSystemBlocks, shouldShapePayload } from "./system-shape.ts";
import { isRecord } from "./type-guards.ts";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type NativeMessagesRequestInput = {
  accessToken: string;
  payload: Record<string, unknown>;
  cacheRetention?: "none" | "short" | "long";
  supportsLongCacheRetention?: boolean;
};

export type NativeMessagesRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const SHORT_EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;
const LONG_EPHEMERAL_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

type CacheControl = typeof SHORT_EPHEMERAL_CACHE_CONTROL | typeof LONG_EPHEMERAL_CACHE_CONTROL;

type JsonRecord = Record<string, unknown>;

function resolveCacheRetention(retention: NativeMessagesRequestInput["cacheRetention"]): NonNullable<NativeMessagesRequestInput["cacheRetention"]> {
  if (retention) return retention;
  return process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

function cacheControlFor(
  retention: NativeMessagesRequestInput["cacheRetention"],
  supportsLongCacheRetention: boolean,
): CacheControl {
  return resolveCacheRetention(retention) === "long" && supportsLongCacheRetention
    ? LONG_EPHEMERAL_CACHE_CONTROL
    : SHORT_EPHEMERAL_CACHE_CONTROL;
}

function withCacheControl<T extends JsonRecord>(block: T, cacheControl: CacheControl): T {
  if ("cache_control" in block) return block;
  return { ...block, cache_control: cacheControl };
}

function cacheSystemBlocks(system: unknown, cacheControl: CacheControl): unknown {
  if (!Array.isArray(system)) return system;
  return system.map((block) => {
    if (!isRecord(block) || block.type !== "text") return block;
    return withCacheControl(block, cacheControl);
  });
}

function canCacheMessageContentBlock(block: JsonRecord): boolean {
  return block.type === "text" || block.type === "image" || block.type === "tool_result";
}

function cacheLastUserMessage(messages: unknown, cacheControl: CacheControl): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const lastMessage = messages.at(-1);
  if (!isRecord(lastMessage) || lastMessage.role !== "user") return messages;

  if (typeof lastMessage.content === "string") {
    return [
      ...messages.slice(0, -1),
      {
        ...lastMessage,
        content: [{ type: "text", text: lastMessage.content, cache_control: cacheControl }],
      },
    ];
  }

  if (!Array.isArray(lastMessage.content) || lastMessage.content.length === 0) return messages;

  const lastBlock = lastMessage.content.at(-1);
  if (!isRecord(lastBlock) || !canCacheMessageContentBlock(lastBlock)) return messages;

  return [
    ...messages.slice(0, -1),
    {
      ...lastMessage,
      content: [
        ...lastMessage.content.slice(0, -1),
        withCacheControl(lastBlock, cacheControl),
      ],
    },
  ];
}

function cacheLastToolSchema(tools: unknown, cacheControl: CacheControl): unknown {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const lastTool = tools.at(-1);
  if (!isRecord(lastTool)) return tools;
  return [...tools.slice(0, -1), withCacheControl(lastTool, cacheControl)];
}

function addPromptCaching(
  payload: Record<string, unknown>,
  retention: NativeMessagesRequestInput["cacheRetention"],
  supportsLongCacheRetention: boolean,
): Record<string, unknown> {
  const cacheControl = cacheControlFor(retention, supportsLongCacheRetention);
  return {
    ...payload,
    system: cacheSystemBlocks(payload.system, cacheControl),
    messages: cacheLastUserMessage(payload.messages, cacheControl),
    ...("tools" in payload ? { tools: cacheLastToolSchema(payload.tools, cacheControl) } : {}),
  };
}

export function buildNativeMessagesRequest(
  input: NativeMessagesRequestInput,
): NativeMessagesRequest {
  const shapedPayload = shouldShapePayload(input.payload)
    ? (resolveCacheRetention(input.cacheRetention) === "none"
      ? shapeSystemBlocks(input.payload)
      : addPromptCaching(
        shapeSystemBlocks(input.payload),
        input.cacheRetention,
        input.supportsLongCacheRetention ?? true,
      ))
    : input.payload;

  // Tool-call concurrency parity with Pi's built-in Anthropic provider: we omit
  // `tool_choice` entirely (Anthropic defaults to `auto` with parallel tool use
  // allowed) rather than forcing `disable_parallel_tool_use: true`. Pi's harness
  // runs a message's tool calls in parallel by default, and its built-in `edit`/
  // `write` tools already serialize same-file mutations through a per-realpath
  // mutation queue that applies regardless of provider. The remaining exposure
  // (concurrent `bash`, or `bash` + `edit` on the same file) is the same default
  // Pi and Claude Code accept. NOTE: revisit (e.g. re-add the serial wire flag)
  // if we hit real parallel-tool-call races in practice.
  // The server-side fallback beta header travels with the `fallbacks` payload
  // parameter (Fable 5 refusal fallback); sending the parameter without the
  // header is a 400, and the header without the parameter is inert noise.
  const hasFallbacks = Array.isArray(shapedPayload.fallbacks) && shapedPayload.fallbacks.length > 0;
  // The interleaved-thinking beta is only load-bearing for manual-budget
  // thinking models (`thinking.type === "enabled"`); adaptive-thinking models
  // imply it server-side and absent thinking does not need it. Derive it from
  // the payload (like `hasFallbacks`) so header construction stays payload-
  // driven and needs no model object.
  const manualBudgetThinking = isRecord(shapedPayload.thinking)
    && shapedPayload.thinking.type === "enabled";

  return {
    url: ANTHROPIC_MESSAGES_URL,
    method: "POST",
    headers: buildNativeHeaders(input.accessToken, {
      ...(hasFallbacks ? { serverSideFallback: true } : {}),
      ...(manualBudgetThinking ? { interleavedThinking: true } : {}),
    }),
    body: shapedPayload,
  };
}
