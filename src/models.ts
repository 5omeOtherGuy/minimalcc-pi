import type { AnthropicMessagesCompat } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import {
  MESSAGE_BATCHES_300K_OUTPUT_BETA,
  MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
} from "./constants.ts";

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
  /** Beta header for 300k message-batch output (batch API only; unused for streaming). */
  messageBatchesOutputBeta?: string;
  /** Max output tokens permitted under the 300k message-batch beta. */
  messageBatchesOutputMaxTokens?: number;
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
export const CLAUDE_SUBSCRIPTION_OPUS_4_7_THINKING_LEVEL_MAP = CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const CLAUDE_TEXT_AND_IMAGE_INPUT = ["text", "image"] as const;
const MESSAGE_BATCHES_OUTPUT_300K_COMPAT = {
  messageBatchesOutputBeta: MESSAGE_BATCHES_300K_OUTPUT_BETA,
  messageBatchesOutputMaxTokens: MESSAGE_BATCHES_300K_OUTPUT_MAX_TOKENS,
} as const;

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
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
  };
}

export const MODELS = [
  claudeSubscriptionModel("claude-haiku-4-5", "Claude Haiku 4.5 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_BUDGET_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP, { ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }),
  claudeSubscriptionModel("claude-opus-4-6", "Claude Opus 4.6 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP, { ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }),
  claudeSubscriptionModel("claude-opus-4-7", "Claude Opus 4.7 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }),
  claudeSubscriptionModel("claude-opus-4-7-300k", "Claude Opus 4.7 300k (Claude Code subscription)", 300000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, nativeModelId: "claude-opus-4-7", ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }),
  claudeSubscriptionModel("claude-opus-4-8", "Claude Opus 4.8 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, ...MESSAGE_BATCHES_OUTPUT_300K_COMPAT }),
  // Fable 5: thinking is always on server-side (explicit adaptive is accepted;
  // explicit disabled 400s, so the no-reasoning path must omit `thinking`).
  // Sampling params are rejected. Safety classifiers can return
  // `stop_reason: "refusal"`; the refusalFallbackModel drives the server-side
  // fallback to Opus 4.8, mirroring native Claude Code's built-in fallback.
  // The 300k batch-output beta is intentionally not declared (undocumented for
  // Fable 5).
  claudeSubscriptionModel("claude-fable-5", "Claude Fable 5 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_ADAPTIVE_OPUS_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true, refusalFallbackModel: "claude-opus-4-8" }),
] as const;
