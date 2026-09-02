import { getModel, type AnthropicMessagesCompat } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription";
export const CLAUDE_SUBSCRIPTION_NATIVE_API_ID = "claude-subscription-native";
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/**
 * Compatibility metadata carried by native Claude subscription models. Extends
 * the upstream Anthropic Messages compat surface (`forceAdaptiveThinking`,
 * `supportsLongCacheRetention`, ...) with extension-specific routing/output
 * fields that pi-ai does not model natively.
 */
export type AnthropicCompat = AnthropicMessagesCompat & {
  /** Upstream Anthropic model id to send when the Pi model id is a soft-cap alias. */
  nativeModelId?: string;
  /**
   * Native model id to retry on server-side when Anthropic safety classifiers
   * decline a request (Fable 5 `stop_reason: "refusal"`). Sent as the
   * `fallbacks` request parameter under the server-side fallback beta so the
   * model switch happens in one round trip without re-reading the context.
   */
  refusalFallbackModel?: string;
};

export const CLAUDE_SUBSCRIPTION_BUDGET_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
} as const satisfies ThinkingLevelMap;

export const CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP = {
  xhigh: "max",
} as const satisfies ThinkingLevelMap;

export const CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP = {
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "max",
} as const satisfies ThinkingLevelMap;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const CLAUDE_TEXT_AND_IMAGE_INPUT = ["text", "image"] as const;

// Subscription requests are prepaid, but Pi's usage/cost pipeline
// (`calculateCost`) multiplies these per-MTok rates by the streamed Anthropic
// usage tokens, so real rates surface the equivalent API cost instead of $0.
// Rates come from pi-ai's own Anthropic catalog keyed by native model id.
// ponytail: snapshot rates for ids the installed pi-ai catalog does not know
// yet; drop entries here once the peer pi-ai ships them.
const FALLBACK_API_COSTS: Record<string, ProviderModelConfig["cost"]> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Fable 5.1 cache reads bill at 0.025x input (a quarter of the usual 0.1x).
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

function equivalentApiCost(nativeModelId: string): ProviderModelConfig["cost"] {
  const lookup = getModel as (provider: string, modelId: string) => { cost?: ProviderModelConfig["cost"] } | undefined;
  return { ...(lookup("anthropic", nativeModelId)?.cost ?? FALLBACK_API_COSTS[nativeModelId] ?? ZERO_COST) };
}

function claudeSubscriptionModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  thinkingLevelMap: ThinkingLevelMap,
  compat?: AnthropicCompat,
): ProviderModelConfig {
  return {
    id,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    name,
    reasoning: true,
    thinkingLevelMap,
    ...(compat ? { compat } : {}),
    input: [...CLAUDE_TEXT_AND_IMAGE_INPUT],
    cost: equivalentApiCost(compat?.nativeModelId ?? id),
    contextWindow,
    maxTokens,
  };
}

export const MODELS = [
  claudeSubscriptionModel("claude-haiku-4-5", "Claude Haiku 4.5 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_BUDGET_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-opus-4-6", "Claude Opus 4.6 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-opus-4-7", "Claude Opus 4.7 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true }),
  claudeSubscriptionModel("claude-opus-4-7-300k", "Claude Opus 4.7 300k (Claude Code subscription)", 300000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, nativeModelId: "claude-opus-4-7" }),
  claudeSubscriptionModel("claude-opus-4-8", "Claude Opus 4.8 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true }),
  claudeSubscriptionModel("claude-opus-5", "Claude Opus 5 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true }),
  // Fable 5: thinking is always on server-side (explicit adaptive is accepted;
  // explicit disabled 400s, so the no-reasoning path must omit `thinking`).
  // Sampling params are rejected. Safety classifiers can return
  // `stop_reason: "refusal"`; the refusalFallbackModel drives the server-side
  // fallback to Opus 4.8, mirroring native Claude Code's built-in fallback.
  // The 300k batch-output beta is intentionally not declared (undocumented for
  // Fable 5).
  claudeSubscriptionModel("claude-fable-5", "Claude Fable 5 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, refusalFallbackModel: "claude-opus-4-8" }),
  // Fable 5.1 (released 2026-09-01): same always-on adaptive thinking shape as
  // Fable 5 (omit `thinking` when Pi reasoning is off; sampling params 400),
  // same refusal classifier surface. Permitted server-side fallback targets are
  // Opus 4.8 and Opus 5; we target the newest. Cache reads bill at a quarter of
  // the usual rate (see FALLBACK_API_COSTS). Forced tool use 400s on this model,
  // but the provider never sends `tool_choice`, so nothing to change there.
  claudeSubscriptionModel("claude-fable-5-1", "Claude Fable 5.1 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, refusalFallbackModel: "claude-opus-5" }),
  // Sonnet 5: adaptive thinking enabled; 1,000,000-token context (the default
  // and only variant) and a 128,000-token synchronous output cap. Same request
  // shape as the adaptive Opus models, with no refusal fallback.
  claudeSubscriptionModel("claude-sonnet-5", "Claude Sonnet 5 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true }),
] as const;
