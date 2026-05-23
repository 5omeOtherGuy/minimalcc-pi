export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription";
export const CLAUDE_SUBSCRIPTION_NATIVE_API_ID = "claude-subscription-native";
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;
type AnthropicCompat = { forceAdaptiveThinking?: boolean };

export const CLAUDE_SUBSCRIPTION_BUDGET_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
} as const satisfies ThinkingLevelMap;

export const CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP = {
  xhigh: "max",
} as const satisfies ThinkingLevelMap;

export const CLAUDE_SUBSCRIPTION_OPUS_4_7_THINKING_LEVEL_MAP = {
  minimal: null,
  xhigh: "xhigh",
} as const satisfies ThinkingLevelMap;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const CLAUDE_TEXT_AND_IMAGE_INPUT = ["text", "image"] as const;

function claudeSubscriptionModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  thinkingLevelMap: ThinkingLevelMap,
  compat?: AnthropicCompat,
) {
  return {
    id,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    name,
    reasoning: true,
    thinkingLevelMap,
    ...(compat ? { compat } : {}),
    input: CLAUDE_TEXT_AND_IMAGE_INPUT,
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  } as const;
}

export const MODELS = [
  claudeSubscriptionModel("claude-haiku-4-5", "Claude Haiku 4.5 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_BUDGET_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Claude Code subscription)", 200000, 64000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-opus-4-6", "Claude Opus 4.6 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_4_6_THINKING_LEVEL_MAP),
  claudeSubscriptionModel("claude-opus-4-7", "Claude Opus 4.7 (Claude Code subscription)", 1000000, 128000, CLAUDE_SUBSCRIPTION_OPUS_4_7_THINKING_LEVEL_MAP, { forceAdaptiveThinking: true }),
] as const;
