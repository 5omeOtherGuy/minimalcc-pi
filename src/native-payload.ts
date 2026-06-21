import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";

import { type AnthropicCompat } from "./models.ts";
import { convertMessages } from "./native-message-conversion.ts";

// pi-ai types `Model<Api>["compat"]` as a union that excludes our custom API's
// compat shape, so the native compat metadata is read through one typed accessor
// instead of scattered structural casts.
export function nativeCompat(model: Model<Api>): AnthropicCompat | undefined {
  return model.compat as AnthropicCompat | undefined;
}

function convertTools(tools: readonly Tool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// Process-level latch: if the OAuth lane ever rejects the `fallbacks`
// parameter (beta not enabled for this account/lane), stop sending it for the
// rest of the process instead of paying a failed round trip per request.
let serverSideFallbackUnsupported = false;

export function resetServerSideFallbackSupportForTests(): void {
  serverSideFallbackUnsupported = false;
}

export function markServerSideFallbackUnsupported(): void {
  serverSideFallbackUnsupported = true;
}

export function isServerSideFallbackRejectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\D)400(?:\D|$)/.test(message) && /fallback/i.test(message);
}

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32768,
};
const ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN = /\bopus-4[-.](?:7|8)(?:\b|-)/;
// Anthropic requires extended thinking budget_tokens >= 1024 and budget_tokens <
// max_tokens; payloads outside this band fail with a 400 invalid_request_error.
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

function thinkingBudget(options: SimpleStreamOptions): number {
  if (!options.reasoning) return 0;
  const customBudget = (options.thinkingBudgets as Record<string, number | undefined> | undefined)?.[options.reasoning];
  return typeof customBudget === "number"
    ? customBudget
    : DEFAULT_THINKING_BUDGETS[options.reasoning] ?? 10240;
}

function requiresAdaptiveThinking(model: Model<Api>): boolean {
  return nativeCompat(model)?.forceAdaptiveThinking === true
    || ADAPTIVE_THINKING_REQUIRED_MODEL_PATTERN.test(model.id);
}

function mapThinkingLevelToEffort(model: Model<Api>, options: SimpleStreamOptions): string {
  const mapped = options.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
  if (typeof mapped === "string") return mapped;
  switch (options.reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "high";
  }
}

// Returns a valid (max_tokens, budget_tokens) pair under Anthropic's invariants:
//   - Anthropic max_tokens covers BOTH thinking and visible output.
//   - budget_tokens must satisfy 1024 <= budget_tokens < max_tokens.
//   - max_tokens must not exceed the model's maxTokens cap.
// The caller's options.maxTokens is treated as a visible-output ask (matching
// upstream pi-ai's Anthropic provider). We expand Anthropic max_tokens to
// cover the thinking budget on top of that ask, and only reduce or omit the
// thinking budget when the model cap forces an otherwise-invalid payload.
function resolveManualThinkingPayload(
  model: Model<Api>,
  options: SimpleStreamOptions,
  requestedBudget: number,
): { maxTokens: number; budgetTokens: number } {
  const requestedOutputTokens = options.maxTokens ?? model.maxTokens;
  const clampedOutput = Math.min(requestedOutputTokens, model.maxTokens);

  if (requestedBudget <= 0) {
    return { maxTokens: clampedOutput, budgetTokens: 0 };
  }

  const adjustedMaxTokens = Math.min(clampedOutput + requestedBudget, model.maxTokens);
  if (requestedBudget < adjustedMaxTokens) {
    return { maxTokens: adjustedMaxTokens, budgetTokens: requestedBudget };
  }

  // Model cap forced max_tokens below requestedOutput + requestedBudget. Reduce
  // thinking so budget_tokens < max_tokens, preserving as much output room as
  // possible; omit thinking entirely if no valid budget fits.
  const reducedBudget = adjustedMaxTokens - clampedOutput;
  if (reducedBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS) {
    return { maxTokens: adjustedMaxTokens, budgetTokens: reducedBudget };
  }
  return { maxTokens: clampedOutput, budgetTokens: 0 };
}

function nativePayloadModelId(model: Model<Api>): string {
  const nativeModelId = nativeCompat(model)?.nativeModelId;
  return typeof nativeModelId === "string" && nativeModelId.trim().length > 0 ? nativeModelId : model.id;
}

export function contextToPayload(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): Record<string, unknown> {
  const tools = convertTools(context.tools);
  const payload: Record<string, unknown> = {
    model: nativePayloadModelId(model),
    max_tokens: options.maxTokens ?? model.maxTokens,
    messages: convertMessages(context.messages, model),
    system: context.systemPrompt ?? "",
    stream: true,
  };

  if (tools) payload.tools = tools;
  if (options.metadata) payload.metadata = options.metadata;

  const thinkingEnabled = model.reasoning && !!options.reasoning;
  if (thinkingEnabled && requiresAdaptiveThinking(model)) {
    payload.thinking = { type: "adaptive", display: "summarized" };
    payload.output_config = { effort: mapThinkingLevelToEffort(model, options) };
  } else {
    const requestedBudget = model.reasoning ? thinkingBudget(options) : 0;
    const { maxTokens, budgetTokens } = resolveManualThinkingPayload(model, options, requestedBudget);
    payload.max_tokens = maxTokens;
    if (budgetTokens > 0) {
      payload.thinking = { type: "enabled", budget_tokens: budgetTokens };
    } else if (typeof options.temperature === "number" && !requiresAdaptiveThinking(model)) {
      payload.temperature = options.temperature;
    }
  }

  // Fable 5 refusal fallback: ask the API to retry a safety-classifier decline
  // on the fallback model server-side (one round trip, fallback-credit
  // repricing), instead of failing the turn and re-sending the full context.
  const refusalFallbackModel = nativeCompat(model)?.refusalFallbackModel;
  if (refusalFallbackModel && !serverSideFallbackUnsupported) {
    payload.fallbacks = [{ model: refusalFallbackModel }];
  }

  return payload;
}
